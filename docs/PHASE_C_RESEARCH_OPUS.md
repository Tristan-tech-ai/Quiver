# Phase C, measured: the aggregation Quiver needs is not recursion

**28 July 2026. Research, repo-only. Nothing here is served, deployed, or on chain. Nothing touches
`hackathon/veritape/src/engine/`, so `q1-e1fa99d08887d6cc` does not move.** Every probe circuit and
script written for this document lived in a scratchpad outside the repo; the repo's own artifacts were
read, never rewritten.

Phase C asks for recursive proof aggregation: fold *n* proofs into one that says "all *n* of these
verified". This document establishes what that costs, what the toolchain can actually do, and whether
the phase is the right answer to the problem it names.

The short version, and everything below is the evidence for it:

- **Recursion is not buildable here.** A BN254 Plonk verifier inside a BN254 circuit costs on the
  order of 10^8 constraints by a cost model whose every factor was measured. That needs a ceremony
  file larger than any that exists.
- **The done condition is achievable anyway, without recursion.** One wide circuit that states 100
  answers at once, with the answers packed two per public field element, verifies for about **333,000
  gas** against a bar of **1,345,154**. That is 4.0x under, measured or interpolated from measured
  points at every step.
- **The abandon condition has not been met, and as written it cannot discriminate.**
- **The stated motivation does not survive contact with X Layer.** 100 separate verifications cost
  0.000535 OKB and fit inside a block with 87% of the block gas limit to spare. Both numbers were read
  off the chain today.
- **The two things are not the same thing.** Recursion aggregates *proofs*; widening aggregates
  *statements*. Quiver holds every witness it sells, so widening is sufficient for Quiver's own
  batches and useless for aggregating a proof somebody else made. That boundary is the real finding.

---

## 1. What the toolchain actually is

The roadmap's Phase C status note says `snarkjs@0.7.6` "exposes `plonk: setup, fullProve, prove,
verify, exportSolidityCallData` and nothing else". The `plonk` half of that is exactly right. The
"nothing else" is not: it was checked today by enumerating the module.

| namespace | exported |
|---|---|
| `plonk` | `setup, prove, fullProve, verify, exportSolidityCallData` |
| `groth16` | `prove, fullProve, verify, exportSolidityCallData` (no `setup`; that is `zKey.newZKey`) |
| `fflonk` | `setup, prove, fullProve, verify, exportSolidityVerifier, exportSolidityCallData` |
| `powersOfTau` | `newAccumulator, contribute, challengeContribute, importResponse, beacon, verify, preparePhase2, truncate, convert, exportChallenge, exportJson` |
| `zKey` | `newZKey, contribute, beacon, verifyFromR1cs, verifyFromInit, exportVerificationKey, exportSolidityVerifier, exportBellman, importBellman, exportJson` |
| `r1cs`, `wtns`, `curves` | `info/print/exportJson`, `calculate/check/debug/exportJson`, `getCurveFromName/getCurveFromQ/getCurveFromR` |

**Measured.** The conclusion the note draws is still correct: there is no aggregation, recursion,
folding, accumulation or inner-product primitive anywhere in the library. But two of the omissions
matter.

`fflonk` exists and was never tried. It was tried today and it does not run: `fflonk setup` on the
372-constraint `kelly` circuit fails against `hez_final_12` with

> Powers of Tau is not big enough for this circuit size. Section 2 too small.

The reason is in the source, not inferred: `snarkjs/src/fflonk_setup.js:115` requires
`domainSize * 9 + 18` G1 points, because fflonk commits nine polynomials into one. `kelly` at domain
1,024 therefore needs a 2^14 file. **fflonk is unusable on this machine for even the smallest circuit
in the repo.**

`powersOfTau.contribute` and `zKey.beacon` also exist, which is a Phase E fact rather than a Phase C
one: the multi-party ceremony that Phase E is blocked on is runnable in-library.

### Curves

A cycle of curves is the structurally correct way to do recursion, so the first question is which
curves the library has. Measured by calling `getCurveFromName` on each:

| name | result |
|---|---|
| `bn128`, `bn254`, `altbn128` | supported, all three alias the same curve; r and q both 254 bits |
| `bls12381`, `bls12-381` | supported; r 255 bits, q 381 bits |
| `grumpkin`, `pallas`, `vesta`, `bw6-761`, `mnt4`, `mnt6` | **`Curve not supported`** |

Every curve that forms a cycle or a 2-chain with something is absent. There is no cycle available in
this library, and adding one is not a configuration change: it is a different implementation of the
whole proving stack.

### Circuit library

`circomlib` ships 36 circuit files. Grepping them for `big`, `pair`, `field`, `fp` or `non` returns
nothing. There is no non-native arithmetic, no bigint gadget and no pairing gadget in the library this
project builds on. The only elliptic-curve templates present are the BabyJubjub ones
(`escalarmul*`, `babyjub`, `eddsa*`), and those are cheap precisely because BabyJubjub's base field
*is* BN254's scalar field, so they are native. That is the same trick recursion needs and cannot have.

---

## 2. What is actually in the repo, read from the artifacts

Every number in this table came out of `build/*.r1cs` and `build/*_plonk.zkey`, via
`zk/scripts/circuit-facts.mjs`'s `plonkFacts` and `snarkjs.r1cs.info`. **Measured.**

| circuit | R1CS | Plonk | ratio | public | domain | zkey |
|---|---|---|---|---|---|---|
| `kelly` | 372 | 718 | 1.93 | 5 | 1,024 | 2.1 MB |
| `concentration` | 451 | 834 | 1.85 | 12 | 1,024 | 3.2 MB |
| `divergence` | 463 | 887 | 1.92 | 7 | 1,024 | 2.4 MB |
| `liquidation` | 667 | 1,301 | 1.95 | 8 | 2,048 | 5.2 MB |
| `constantproduct` | 671 | 1,293 | 1.93 | 10 | 2,048 | 5.8 MB |
| `greeksfp` | 1,065 | 1,919 | 1.80 | 13 | 2,048 | 6.8 MB |
| `greeks` | 1,103 | 2,152 | 1.95 | 13 | 4,096 | 13.5 MB |
| `parity` | 1,153 | 2,255 | 1.96 | 13 | 4,096 | 13.5 MB |
| `greekssigned` | 1,952 | 3,615 | 1.85 | 29 | 4,096 | 23.5 MB |
| `padprobe` | 3,900 | 3,902 | 1.00 | 2 | 4,096 | 6.5 MB |

The R1CS-to-Plonk ratio is not a constant. It is 1.80 to 1.96 for the real circuits, which are
comparator-heavy, and exactly 1.00 for `padprobe`, which is a bare multiplication chain.
`build-circuit.mjs` already knows this and refuses only what cannot fit under any expansion. The
number used below for batch-shaped circuits is **2.16**, measured on an actual batch circuit rather
than borrowed from this table.

Machine, for the memory arguments later: **31.6 GB RAM, 12 cores**, 11.1 GB free at the time of
measurement.

---

## 3. Where a Plonk verify's gas actually goes

Everything about batching turns on this split, and it had never been taken. Measured by running the
snarkjs-exported verifier inside `@ethereumjs/evm` (Cancun) and counting every `STATICCALL` to the
BN254 precompiles, then charging them at the Istanbul schedule (ecAdd 150, ecMul 6,000, ecPairing
45,000 + 34,000 per term).

| component | count | gas | share |
|---|---|---|---|
| `ecMul` 0x07 | 18 | 108,000 | 39.8% |
| `ecPairing` 0x08 | 1 call, 2 terms | 113,000 | 41.6% |
| `ecAdd` 0x06 | 18 | 2,700 | 1.0% |
| everything else (EVM, F_r arithmetic, transcript keccak) | | 47,754 | 17.6% |
| **total execution gas** | | **271,454** | |

That is `kelly`, 5 public signals. `constantproduct` with 10 public signals: identical precompile
counts, 275,436 total. The precompile counts do not move with circuit size, which is the fact the
whole Route A / Route B comparison in gate B6 already rested on.

The counts match the JS verifier exactly, which is a useful cross-check that neither instrument is
lying. Reading `snarkjs/src/plonk_verify.js`: `calculateD` does 9 scalar multiplications,
`calculateF` 5, `calculateE` 1, `isValidPairing` 3, total 18; and one two-term `pairingEq`.

**Eight of the eighteen scalar multiplications are on verification-key points** (`Qm, Ql, Qr, Qo, S3,
S1, S2`, and the generator in `calculateE`). Ten are on proof points. That split is what decides how
much a batched verifier could save, in section 6.

### A note on the three different numbers for "a Plonk verify"

The repo records 273,901 (`gate0-plonk.json`, the liquidation verifier, 8 public signals) and 273,118
(`gateB2-kelly-evm.json`, kelly, 5 public signals, and the constant gate B6 uses as `ROUTE_A_GAS`).
Today's re-measurement of kelly gives 271,454. The spread is 0.9%, and it is not noise: these are
different circuits, different public-input counts and slightly different call paths. The next section
shows the public-input count alone explains most of it at 822 gas each. Nothing is wrong, but any
document that quotes "273k" as *the* number is quoting one row of a curve.

---

## 4. The measured cost of what Phase C names

### 4.1 Why BN254-in-BN254 is expensive, precisely

A circom circuit compiled for BN254 does arithmetic modulo the **scalar** field
`r = 21888242871839275222246405745257275088548364400416034343698204186575808495617`. A Plonk verifier
does arithmetic on curve points, whose coordinates live in the **base** field
`q = 21888242871839275222246405745257275088696311157297823662689037894645226208583`. They differ from
the 32nd hexadecimal digit onward. So every base-field operation the verifier performs has to be
emulated: carried in limbs, with the modular reduction witnessed and then checked.

That is the entire difficulty. It is not a pairing-specific problem, and there is no structural
impossibility anywhere in it. It is an arithmetic tax, and the tax was measured rather than recalled.

### 4.2 How many base-field operations, measured

`@noble/curves` 1.9.7 is installed as a transitive dependency and implements BN254 in pure
JavaScript. Its field objects are frozen, so the field *constructor* in `abstract/modular.js` was
patched before `bn254.js` loaded, handing the tower an instrumented clone that counts calls. The
library memoizes the G2 line-coefficient precompute and the wNAF tables, so the first call of anything
is not the algorithmic cost; each operation was run four times and the steady state taken.
Bilinearity was checked (`e(3P,Q) == e(P,Q)^3`) so the counts are of a working pairing.

| operation | F_q multiplications (mul + sqr), steady state |
|---|---|
| G1 point addition | 18 |
| G1 point doubling | 17 |
| optimal-ate Miller loop, one pair | 8,116 |
| final exponentiation | 15,511 |
| **full pairing** | **23,627** |
| Miller loop, two pairs | 12,720 |
| **two-pair product with one shared final exponentiation** | **28,231** |

The marginal cost of a second pairing inside a product is 4,604, not 23,627: the final exponentiation
is shared. That is why the on-chain verifier uses one `ecPairing` call with two terms rather than two
calls.

### 4.3 What one emulated multiplication costs in circom, measured

A gadget was written and compiled: 4 limbs of 64 bits, the quotient and remainder witnessed, `a*b`
folded into `2k-1` unreduced limbs and constrained by evaluating both sides at `2k-1` points, then
`a*b - t*q - r` carried to zero with a range check per limb. The modulus is a compile-time constant,
so `t*q` is a linear combination and free.

A constraint count means nothing if the gadget does not constrain, so it was tested:

```
accepts an honest (a,b,quot,rem):  out == a*b mod q ?  YES
refuses rem+1                    :  YES
refuses quot+1                   :  YES

R1CS: 998 constraints, 1000 vars
```

**998 R1CS constraints per emulated base-field multiplication.** This is a *floor*, for two reasons:
it omits the `r < q` check that full soundness needs, and it charges nothing for the emulated
additions, of which a pairing performs about 67,000.

### 4.4 The cost model

| step | value | how |
|---|---|---|
| scalar multiplications in a Plonk verify | 18 | measured (JS source and EVM precompile counts agree) |
| F_q muls per 254-bit scalar multiplication | 6,604 | 254 doublings x 17 + 127 additions x 18, from measured per-op counts |
| F_q muls for 18 scalar multiplications | 118,872 | product |
| F_q muls for the two-pair product | 28,231 | measured |
| **total F_q multiplications** | **147,103** | sum |
| x 998 R1CS each | **146.8 million R1CS** | product of two measured factors |
| x 2.16 Plonk expansion | **317 million Plonk gates** | measured ratio for a batch-shaped circuit |
| evaluation domain required | **2^29** (536,870,912) | next power of two |

The scalar multiplications, not the pairing, are four fifths of it. That is worth saying plainly
because the roadmap's status note attributes the cost to "emulating a pairing", and the pairing is the
smaller half.

### 4.5 Against the ceremony files that exist

Every size below was read by HTTP HEAD against the Hermez ceremony bucket today. **Measured.**

| ptau | bytes | size |
|---|---|---|
| 2^12 (on disk) | 4,801,688 | 4.6 MB |
| 2^14 | 18,957,464 | 18.1 MB |
| 2^16 | 75,580,568 | 72.1 MB |
| 2^17 | 151,078,040 | 144.1 MB |
| 2^18 | 302,072,984 | 288.1 MB |
| 2^20 | 1,208,042,648 | 1,152.1 MB |
| 2^22 | 4,831,921,304 | 4,608.1 MB |
| 2^24 | 19,327,435,928 | 18,432.1 MB |
| 2^25 | 38,654,788,760 | 36,864.1 MB |
| 2^26 | 77,309,494,424 | 73,728.1 MB |
| 2^27 | 154,618,905,752 | 147,456.1 MB |
| 2^28 (`powersOfTau28_hez_final.ptau`) | | **288.0 GB** |
| 2^29 | does not exist | |

The per-power files stop at 2^27; `powersOfTau28_hez_final_28.ptau` returns 404 and the 2^28 file is
the unsuffixed one. **The file a Plonk-in-Plonk verifier needs is one power past the largest that
exists.**

Proving time was re-measured today (`domain-scaling.mjs`): 339 ms at domain 1,024, 742 ms at 2,048,
1,336 ms at 4,096, so time grows as **domain^0.99**. (The roadmap quotes 1.01 from an earlier run;
0.99 is today's fit over the same three points. The difference is not material and both are what
O(n log n) looks like over two doublings.) Extrapolating that exponent across seventeen doublings to
2^29 gives about **46 hours**, which is a number worth writing down only to be clear it is not the
binding constraint: snarkjs would need a proving key on the order of half a terabyte, against 31.6 GB
of RAM.

### 4.6 How wrong could this be, honestly

Very, in the favourable direction, and it does not change the verdict.

The 998-constraint gadget is naive. It reduces after every multiplication; production emulated
arithmetic (lazy reduction, tight bounds, lookup arguments) does far better. Eprint 2025/695,
*Efficient Foreign-Field Arithmetic in PLONK*, states that its technique reduces the overhead of
elliptic-curve emulation "from two or three orders of magnitude to just one order of magnitude", and
gives BN254 self-emulation parameters (B=252, n=6 limbs). Taking that at face value, the same verifier
could be 10x to 100x smaller: **1.5 to 15 million R1CS**, 3 to 32 million Plonk gates, domain 2^22 to
2^25, ceremony file 4.6 GB to 36.9 GB (measured sizes above).

An independent anchor in the same range: a gnark recursive verifier for a Circom **Groth16** proof is
reported at 4,772,531 constraints. Groth16 verification is structurally cheaper than Plonk (three
pairings, one small public-input MSM, none of the eighteen scalar multiplications), so a Plonk-in-Plonk
verifier is larger than that, not smaller.

So the honest statement is: **the true figure is somewhere between about 1.5 million and 150 million
constraints depending on the quality of the emulation, and every point in that range is outside what
snarkjs and a 31.6 GB machine can prove.** The lower end is not a snarkjs circuit at all; it is a
gnark or arkworks circuit, in Go or Rust, with a different frontend, a different proving key format
and a different verifier. That is a stack change, exactly as the roadmap says, and the roadmap is
right about that even though its stated reason (the pairing) is the smaller part of the cost.

---

## 5. The route that works, measured end to end

Phase C's framing is "fold *n* proofs into one". There is a different question with the same answer
for Quiver's purposes: **prove *n* statements in one circuit.** No recursion, no new curve, no new
proving system, and the circuits already exist.

The reason this is even on the table is a fact about Quiver specifically: **Quiver computes every
answer it sells, so it holds every witness.** A party that holds all the witnesses does not need to
aggregate proofs; it can decline to make *n* proofs in the first place. Recursion is for aggregating
proofs made by someone else, or made at times you cannot control. Section 9 says exactly what that
costs.

### 5.1 The shape, and why the public inputs are packed

A first attempt committed the batch with a Poseidon rolling hash and exposed one public signal. It
works and it is the cheapest on chain, but it puts the members off chain: the contract certifies a
root and cannot see what is under it. Measured cost, by compiling `BatchKellyRoot(N)` for N from 1 to
1000: exactly **1,206 R1CS per answer**, of which the Kelly statement is 371 and `Poseidon(5)` is 835.
The hash costs more than the statement.

The better shape puts the answers themselves on chain. A Kelly answer is `p` (30 bits), `b` (45) and
`f` (45): 120 bits, so **two answers fit in one 254-bit public field element**. The bit decomposition
the unpacking needs is nearly the same one `KellyIdentity` already pays for.

```circom
template BatchKellyPacked(N) {
    signal input packedAnswers[(N+1)\2];
    signal output ok;
    component k[N];
    component split[(N+1)\2];
    for (var s = 0; s < (N+1)\2; s++) { split[s] = Num2Bits(240); split[s].in <== packedAnswers[s]; }
    for (var i = 0; i < N; i++) {
        var s = i \ 2; var off = (i % 2) * 120;
        var p = 0; var b = 0; var f = 0; var w = 1;
        for (var t = 0; t < 30; t++) { p += split[s].out[off + t] * w;      w = w * 2; }
        w = 1; for (var t = 0; t < 45; t++) { b += split[s].out[off + 30 + t] * w; w = w * 2; }
        w = 1; for (var t = 0; t < 45; t++) { f += split[s].out[off + 75 + t] * w; w = w * 2; }
        k[i] = KellyIdentity(1000000000, 30, 45, 45, 100);
        k[i].pHat <== p; k[i].bHat <== b; k[i].fHat <== f;
    }
}
component main {public [packedAnswers]} = BatchKellyPacked(N);
```

Compiled at seven batch sizes. **Measured, exactly linear:**

| N | public signals | R1CS | R1CS per answer |
|---|---|---|---|
| 2 | 2 | 990 | 495 |
| 4 | 3 | 1,979 | 495 |
| 8 | 5 | 3,957 | 495 |
| 20 | 11 | 9,891 | 495 |
| 40 | 21 | 19,781 | 495 |
| **100** | **51** | **49,451** | **495** |
| 178 | 90 | 88,022 | 495 |

The packing costs 124 R1CS per answer over the unpacked 371, and buys a 4x reduction in public
signals. That trade is what makes the whole thing fit, for the reason in the next section.

### 5.2 There is a hard ceiling on public inputs, and it is 89

This was found by the measurement failing. Building verifiers for probe circuits with 5 to 3,000
public inputs, the deploy stopped working somewhere above 80. Bisected, with the exact runtime
bytecode size:

| public inputs | runtime bytes, optimizer runs=200 | runs=1 | runs=10^6 |
|---|---|---|---|
| 85 | 23,581 | 23,530 | 38,909 over |
| 86 | 23,791 | 23,744 | 39,281 over |
| 87 | 24,003 | 23,956 | 39,655 over |
| 88 | 24,215 | 24,168 | 40,029 over |
| **89** | **24,427** | **24,380** | 40,403 over |
| 90 | **24,641 over** | **24,590 over** | 40,779 over |

EIP-170 caps deployed runtime code at 24,576 bytes. The snarkjs Plonk Solidity template emits about
**212 bytes of runtime code per public input** because it unrolls the Lagrange-evaluation loop, so
**89 public inputs is the ceiling and 90 fails to deploy** with the error `code size to deposit
exceeds maximum code size`. The optimizer setting barely moves it, and turning the optimizer up makes
it dramatically worse.

This is a limit of the *template*, not of Plonk and not of the EVM. A hand-written verifier that loops
over calldata instead of unrolling would not have it. But it is the limit that binds today, and it
means: **at 89 public signals, a packed batch tops out at 176 answers per proof with every answer on
chain.**

### 5.3 What a verify costs as public inputs grow

Every row: real `plonk setup` against `hez_final_12`, real exported Solidity verifier, real EVM run,
honest proof accepted. **Measured.**

| public inputs | execution gas | calldata gas | total |
|---|---|---|---|
| 5 | 273,894 | 13,156 | 287,050 |
| 20 | 286,129 | 15,292 | 301,421 |
| 50 | 312,661 | 19,720 | 332,381 |
| 60 | 319,402 | 21,252 | 340,654 |
| 70 | 327,349 | 22,580 | 349,929 |
| 80 | 335,561 | 24,028 | 359,589 |

**822 gas of execution per extra public input, plus about 145 of calldata.** The precompile count does
not change: 18 `ecMul` at every size. The growth is the per-public-input Lagrange work in the verifier.

### 5.4 Putting it together: 100 answers

| | value | label |
|---|---|---|
| R1CS | 49,451 | **measured** (compiled) |
| public signals | 51 | **measured** |
| Plonk gates | ~106,800 | estimate: measured R1CS x measured 2.16 ratio |
| evaluation domain | 2^17 = 131,072 | derived |
| ceremony file needed | `hez_final_17`, 144.1 MB | **measured** by HTTP HEAD; **not on disk** |
| proving key size | ~210 MB | estimate, scaled from a measured 6.6 MB at domain 4,096 |
| proving time | ~44 s | **extrapolated** from 1,422 ms at domain 4,096 at domain^0.99, five doublings |
| **verify, execution gas** | **~313,300** | interpolated between measured rows at 50 and 60 |
| **verify, calldata gas** | **~19,900** | interpolated between the same rows |
| **verify, total** | **~333,200** | sum |

The 2.16 expansion ratio is itself measured, on a real batch circuit: `bkp_2` is 990 R1CS and its
Plonk setup reports 2,140 constraints at domain 4,096. That circuit proves in **1,422 ms**, measured
over five runs after a warm-up, which is the anchor for the extrapolation above and is reassuringly
close to `padprobe`'s 1,336 ms at the same domain: proving cost follows the domain, not what the
constraints say.

### 5.5 The tamper clause, on chain

The done condition's third clause is that a tampered member must make the aggregate fail. Tested with
a real batched proof in the EVM, not in JS:

```
2 answers, packed into 2 public signal(s), verifier 5986 bytes
honest batch                       accepted=true  gas=268233
member 0 moved by one grid step     accepted=false  (refused)
member 1 moved by one grid step     accepted=false  (refused)
```

Both members live in the same 254-bit word; moving either one, by the smallest representable amount,
is refused. This is not a new property, it is the same public-signal binding every gate in the repo
already exercises, but it is the clause and it is now measured on a batch.

---

## 6. The alternatives, and which of them are real

### Batched pairing verification, without recursion

Several Plonk proofs can share one pairing check: take random `r_j`, verify
`e(-sum r_j A1_j, X_2) * e(sum r_j B1_j, G2) = 1`. The `r_j` fold into the existing scalars at no extra
scalar multiplication. From the measured split in section 3, per additional proof this saves the whole
113,000-gas pairing, and for proofs of the *same* circuit it also collapses the eight
verification-key scalar multiplications (48,000) into eight for the whole batch.

Marginal cost per proof after batching, **estimated from measured components**: 10 `ecMul` (60,000) +
18 `ecAdd` (2,700) + the ~48,000 of transcript and F_r work that every proof needs its own copy of,
so about **110,700**, against the 267,140 measured today. A **2.4x saving**, and 100 proofs would still be
about 11.2 million gas: **8.3x over the done condition's bar.** Batched pairing verification is real,
worth having, and does not reach the target on its own. It also requires writing a Solidity batch
verifier by hand, because the snarkjs template performs the pairing internally and exposes no hook.

### A cycle of curves

Structurally the right answer, and unavailable. BN254's partner is Grumpkin: BN254's base field is
Grumpkin's scalar field and vice versa, which is what makes Aztec's recursion cheap. Grumpkin is not
pairing-friendly, so the Grumpkin side must use an inner-product argument rather than KZG. snarkjs
supports neither Grumpkin (measured: `Curve not supported`) nor IPA. This is Barretenberg, arkworks or
gnark, not this stack.

### A different proof system

| system | recursion | on-chain verify | status for Quiver |
|---|---|---|---|
| Halo2 | accumulation, native | Solidity verifier exists in the ecosystem | whole-stack change, Rust |
| Nova / SuperNova (folding) | IVC, fold one step at a time | reported ~850k gas, ~3.5M to deploy | Sonobe is 0.1.0-alpha.1; its Circom frontend is listed today as "to be revamped"; the decider is reported to need ~36 GB RAM |
| plonky2/3 | native and fast, FRI over Goldilocks | needs wrapping in a BN254 SNARK to verify on chain | two stacks, not one |
| Groth16 + SnarkPack | aggregation of proofs sharing one verification key | logarithmic verifier, but written for Filecoin's native verifier | reuses the Groth16 SRS so no new ceremony, but Quiver's Groth16 ceremony has one participant (Phase E), and no Solidity SnarkPack verifier is known |

Everything in the "reported" column above is from published sources, not measured here, and is labelled
accordingly. The Nova row is the interesting one: **~850k gas for a proof that folds an unbounded
number of steps would pass the done condition**, and folding is the only thing on this list that
solves the incremental problem in section 9. It is also pre-release software with an unfinished Circom
frontend and a decider that needs more RAM than this machine has.

### A Merkle root of proofs with a single verification

Does not work, and the roadmap already says why: a root proves the proofs were committed, not that
they verify. Worth restating only because the fix is not aggregation. **A Merkle root of *answers*,
output by a circuit that proved all of them, closes the gap exactly** (section 5), and the roadmap's
framing of "Merkle root of claims" against "single proof of arithmetic" is a false dichotomy: the
second can produce the first.

### Optimistic

Post the answers with a bond; anyone may challenge by submitting the single proof for one answer; the
contract verifies only when challenged. Posting 100 packed answers is 50 words of calldata, about
25,600 gas, which is **13x cheaper than the batched-proof route and 1,000x cheaper than proving each**.
It buys that with a liveness assumption (somebody must be watching), a challenge window during which
the answer is not final, and capital locked in a bond. For an agent that has to act on the number
*now*, a challenge window is the wrong shape. It belongs in this document because it is the honest
competitor and it is what most of the industry actually ships.

---

## 7. Does the done condition hold?

> **Done means**: 100 answers verify in one transaction for less gas than 5 verify today; the
> aggregate names the circuit ids it covers; a tampered member makes the aggregate fail.

| clause | verdict | evidence |
|---|---|---|
| 100 answers in one transaction | **yes** | one proof, 51 public signals, one `verifyProof` call |
| for less gas than 5 verify today | **yes, 4.0x under** | ~333,200 against **1,345,154**, the measured 5-leg row of `gateB6-portfolio-routes.json` |
| the aggregate names the circuit ids it covers | **yes, at ~1,000 gas each** | one more public signal per named id, at the measured 822 + 145 per signal |
| a tampered member makes the aggregate fail | **yes, measured** | section 5.5 |

Per answer this is **3,332 gas** against **267,140** for a separate proof, an **80x** reduction. That
267,140 is the slope through gate B6's first and last measured rows (276,369 at one leg, 2,947,769 at
eleven); the row-to-row slopes run 265,273 to 267,415, so the series is linear to within 0.8%. The
whole 100-answer batch costs **0.0000067 OKB** at today's measured X Layer gas price.

**The done condition is achievable, and not by the route the phase names.** The work is a batch
wrapper around circuits that already exist, plus a 144 MB ceremony file that is not on disk. Days, not
two months.

---

## 8. Has the abandon condition been met?

> **Abandon if**: aggregation costs more than it saves below 20 answers *and* real usage never batches
> that many.

**No, and as written it cannot decide anything.**

The first clause is false for the widening route by a wide margin. There is no fixed cost to amortise:
a 2-answer batch verifies for 268,233 gas (measured), against 543,000 for two separate proofs. It wins
**from the second answer**, and the break-even is n = 1.

The first clause is vacuously true for the recursion route, because recursion has no break-even at
all: it is not buildable, so it never costs less than anything.

A condition that returns "abandon" for the technique that cannot be built and "continue" for the one
that can, and that never compares them, is not a decision rule. The clause that would actually
discriminate is about *shape*, not cost: does real usage produce answers in batches that are known
before proving starts, or one at a time in a loop? That is section 9's question and this document
does not answer it. **The usage measurement the abandon condition demands has still not been taken**,
and taking it is cheap: count, per buyer, the distribution of calls per minute and whether they arrive
in bursts.

---

## 9. Does the motivation survive?

> Every proof today costs its own transaction. An agent polling risk in a loop cannot put each answer
> on chain, and does not want to.

Measured against X Layer today (chain id 0xc4 = 196, block 66,475,822, two independent RPC endpoints
agreeing):

| | value |
|---|---|
| gas price | **0.0200 gwei** (base fee 0.020000 gwei) |
| block gas limit | **210,000,000** |
| gas used in the latest block | 1,669,778, across 11 transactions |

100 separate verifications in one transaction cost **26,723,229 gas** (extrapolated along gate B6's
measured, exactly linear slope of 267,140 per leg plus a 9,229 intercept). That is:

- **0.000535 OKB.** At any OKB price under $1,000 this is under 54 cents; at $50 it is under three
  cents.
- **12.7% of one block's gas limit.** X Layer can absorb about **786** separate Plonk verifications
  per block, and is currently using under 1% of its capacity.

So on X Layer, neither cost nor block capacity prevents an agent from putting each answer on chain.
The first sentence of the motivation is a statement about Ethereum mainnet, where 26.7M gas would not
fit in a block and would cost real money. On the chain Quiver actually deployed to, it is false.

What *is* true, and what the motivation should have said:

- **21,000 gas of intrinsic cost per transaction**, so 100 separate transactions (as opposed to 100
  verifications inside one) waste 2.1M gas on nothing.
- **Latency and choreography.** An agent that wants one on-chain fact covering the last hour of
  polling would rather submit once than a hundred times, for reasons that have nothing to do with gas.
- **The proof store.** 100 proofs is 100 objects to persist, serve and hash-address (Phase A), against
  one.

Those are real motivations. "Gas" is not, at 0.02 gwei. If Phase C is justified by gas, **the
justification does not survive measurement**, and the phase should be rewritten around the reasons
that do.

---

## 10. What this approach would NOT achieve

This is the section that matters most, because everything above makes widening sound like a free win
and it is not.

**It is not incremental, and that is the whole difference from recursion.** Every answer in a batch
must exist before proving starts. An agent polling risk each block cannot fold answer 101 into an
existing proof; the batch must fill, then prove for ~44 seconds, then submit. Folding schemes (Nova,
HyperNova) exist precisely to remove this, and nothing in section 5 removes it. **If real usage is a
steady trickle rather than a burst, widening is the wrong tool and the right one is not buildable
here.** This is the single most important open question and it is a usage measurement, not a
cryptography question.

**It cannot aggregate a proof it did not make.** Widening aggregates statements, which requires the
witnesses. Recursion aggregates proofs, which requires only the proofs. A third party who bought ten
proofs from Quiver cannot combine them; Quiver would have to reprove all ten as a batch. Any future in
which somebody else aggregates Quiver proofs, or in which Quiver aggregates proofs from other
services, needs real recursion and is closed by this route.

**The batch size and the statement type are baked into the verification key.** A circuit is compiled
for a fixed N and a fixed statement, so `BatchKellyPacked(100)` cannot certify 40 Kelly answers and 60
liquidation answers. Two ways out, both measured or bounded:

- *One proof per statement type.* Up to four types stay under the bar (4 x ~333,200 = 1.33M against
  1,345,154). Five types do not.
- *A multiplexed slot that can be any statement.* circom compiles every branch, so a universal slot
  costs the sum of all six circuits: 372 + 667 + 451 + 463 + 671 + 1,065 = **3,689 R1CS per slot**
  against 495, a 7.4x tax. 100 mixed answers would be ~369,000 R1CS, ~797,000 Plonk gates, domain
  2^20, a 1.15 GB ceremony file and about **6 minutes** of proving (extrapolated).

Padding to a fixed N with dummy answers solves the N half at the cost of proving the dummies.

**176 answers per proof is the ceiling if the answers are to be on chain**, from the measured 89
public-input limit of the snarkjs template. Past that the answers must go under a commitment, and then
the contract certifies a root it cannot look inside. That is still a real product (anyone can check
membership off chain against the root), but it is a weaker claim and it should not be described as
"the answers are on chain".

**Proving does not get cheaper, it gets slightly worse.** ~440 ms per answer inside a batch
(extrapolated) against 339 ms proving `kelly` alone (measured today). Widening moves cost from the
chain to the prover, it does not remove it. It is also all-or-nothing: one member that the encoder
refuses kills the whole proof, where 100 separate proofs would have produced 99.

**It says nothing about whether the inputs are true.** A batch of 100 provably-correct Kelly
fractions computed from 100 wrong probabilities is 100 wrong answers with a proof attached. This is
Phase D and no amount of aggregation touches it.

**It does not prove `N(d2)`, or anything else the underlying circuits do not prove.** A batch inherits
exactly the statement of its members. TIER3's closing paragraph applies unchanged.

**And the thing Phase C literally asks for stays unbuilt.** Recursive proof aggregation on BN254 with
snarkjs is not blocked by cleverness; it is 10^8 constraints with a naive gadget, plausibly 10^6 to
10^7 with a good one, and either way it needs a ceremony file and a proving stack that this repository
does not have. If the phase is kept as written, its first deliverable is not a circuit. It is a
decision to add Rust or Go to the build.

---

## 11. What would settle the open questions

1. **Take the usage measurement the abandon condition already demands.** Per buyer, calls per minute
   and burstiness. It decides between widening (bursts) and folding (trickle), and it is the cheapest
   experiment in this document.
2. **Fetch `hez_final_17` (144.1 MB, measured) and build `BatchKellyPacked(100)` for real.** That
   converts the two extrapolations in section 5.4 (proving time, Plonk gate count) into measurements
   and costs one download and one setup. Nothing else in the argument is unmeasured.
3. **If the answer to (1) is "trickle", evaluate Sonobe against a real Kelly step function** and
   measure its decider RAM and its Solidity verifier gas on this machine rather than trusting the
   reported ~850k and ~36 GB.
4. **If a batched Solidity verifier is wanted anyway**, the 2.4x estimate in section 6 is the number
   to beat, and the measured 41.6% pairing share is where the saving comes from.

---

## 12. How every number here was taken

| number | instrument |
|---|---|
| snarkjs exports, curve support | `Object.keys` on the loaded module; `getCurveFromName` per name |
| circuit sizes | `snarkjs.r1cs.info` and `circuit-facts.mjs`'s `plonkFacts` on `build/*` |
| gas split of a verify | `@ethereumjs/evm` Cancun, `step` events counting `STATICCALL` to 0x06/0x07/0x08, charged at the Istanbul schedule |
| gas against public inputs | probe circuits at 5..3000 public inputs, real `plonk setup` against `hez_final_12`, real exported verifier, real EVM run, honest proof accepted every row |
| EIP-170 ceiling | bisection over 85..90 public inputs at three optimizer settings, deployed bytecode length |
| F_q operation counts | `@noble/curves` 1.9.7 with the field constructor in `abstract/modular.js` patched before load; four runs per operation, steady state taken; bilinearity checked |
| emulated multiplication cost | a circom gadget compiled with the repo's `circom.exe`, witness-tested to accept an honest triple and refuse `rem+1` and `quot+1` |
| batch circuit sizes | `circom --r1cs` at N = 2..1000, no ceremony file required to compile |
| batch proving time | `snarkjs.plonk.prove` on `bkp_2`, five runs after a warm-up, median |
| proving-time exponent | `zk/scripts/domain-scaling.mjs`, re-run today |
| ceremony file sizes | HTTP HEAD against `storage.googleapis.com/zkevm/ptau` |
| X Layer gas price, block gas limit, chain id | `eth_gasPrice`, `eth_getBlockByNumber`, `eth_chainId` against `rpc.xlayer.tech` and `xlayerrpc.okx.com`, agreeing |
| per-leg verify gas | `zk/build/gateB6-portfolio-routes.json`, five measured rows, exactly linear |
| gnark, SnarkPack, Sonobe, foreign-field costs | published sources, **not measured here**, labelled as reported wherever quoted |

The probe circuits and scripts were written into a scratchpad outside the repository and are not part
of it. Section 5.1 contains the batch template in full, and section 4.3 describes the emulated
multiplication gadget completely enough to rebuild: 4 limbs of 64 bits, witnessed quotient and
remainder, `2k-1` evaluation points for the product, carry-to-zero with a range check per limb, and a
constant modulus so `t*q` is linear.
