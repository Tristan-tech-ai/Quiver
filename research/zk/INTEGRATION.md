# INTEGRATION — what this artifact is, and what it is worth

Written so the service/paper session can act on it without talking to this one. Every number below
is measured; `FINDINGS.md` has the run that produced each one.

---

## 1. The one-paragraph version

There is a working Groth16 circuit for the perpetual-futures liquidation identity, a real proof, a
JS verifier, and a Solidity verifier that costs **242,971 gas** to run on-chain. It buys
**succinctness, not privacy, and not trustlessness** — the computation was already trustless because
anyone can re-run the engine, and the circuit has **zero private inputs**, so it hides nothing. What
it adds is a constant-size 256-byte artifact that a party who *cannot execute Node* — a smart
contract, an auditor's tool, an insurer's system — can check in 8 milliseconds or a quarter-million
gas. That is the whole pitch. It is a real gap and this closes it. It is not a bigger claim than that.

---

## 2. Say this, not that

| Do not write | Write instead |
|---|---|
| "Zero-knowledge proof of a private position" | "Succinct proof (SNARK) of the liquidation identity" |
| "Now the computation is trustless" | "The computation was already trustless. This makes it *checkable without re-running it*." |
| "The proof shows the engine computed correctly" | "The proof shows a fixed-point restatement of the identity holds, to within a stated bound." |
| "Proven correct" | "Proven consistent, at 1e-9 scaling, subject to the caveats in §5" |

**On the word "zero-knowledge".** The circuit compiles to **6 public inputs and 0 private inputs.**
Every value it consumes is one the service already publishes in `proof.inputs`. Groth16 is a
zero-knowledge proof *system*, so the phrase is not technically false, but there is no secret in this
statement and calling it a "ZK proof of a private position" would be describing a circuit that does
not exist here. Reviewers who know the field check the private-input count first. Use **succinct**
or **SNARK**. If privacy is ever actually wanted, the change is to move `mHat`/`qHat` out of the
`public` list and commit to them instead — a real design change, not a wording change.

---

## 3. What exists, and how to reproduce it

```
circuits/liquidation.circom      the circuit
src/scale.js                     normative float -> field-element translation
scripts/prove.js                 honest path: position -> proof -> verify
scripts/negative.js              53 cases the verifier must reject
scripts/pin-sweep.js             how tightly P_liq is pinned, over 2400 positions
scripts/gas.mjs                  on-chain gas, executed in a real EVM
build/liquidation_final.zkey     proving key (prover only — never ship this)
build/verification_key.json      verification key (4,209 bytes — this is what you publish)
build/proof.json                 a real proof (855 bytes)
build/public.json                its 8 public signals
build/LiquidationVerifier.sol    Solidity verifier, 2,025 bytes deployed
```

Rebuild from scratch:

```sh
./circom.exe circuits/liquidation.circom --r1cs --wasm --sym -o build
npx snarkjs groth16 setup build/liquidation.r1cs build/pot12_final.ptau build/liquidation_0000.zkey
npx snarkjs zkey contribute build/liquidation_0000.zkey build/liquidation_final.zkey -e=<entropy>
npx snarkjs zkey export verificationkey build/liquidation_final.zkey build/verification_key.json
node scripts/prove.js && node scripts/negative.js && node scripts/pin-sweep.js && node scripts/gas.mjs
```

Note `circom` is **not** an npm package — it is a prebuilt binary saved here as `circom.exe`
(downloaded from the iden3 release as `circom-windows-amd64.exe`, circom 2.2.3, sha256
`e43f132ee6f0aa79b705beceb59c2a7e6a54d7bdeab917ca34e9fc1951d185e1`). snarkjs is pure npm. The claim
"circom + snarkjs is pure npm" is only half true; say so if the paper mentions the stack.

### Measured cost

| | |
|---|---|
| constraints | 667 (649 non-linear + 18 linear) |
| prove (witness + Groth16) | 242 ms |
| verify, JS | 8 ms |
| verify, on-chain | **242,971 gas** |
| proof size | **256 bytes raw** (8 × 32-byte words); 853–856 as JSON |
| verification key | 4,209 bytes |

Proof size is constant *regardless of the position* — that is the point of succinctness. Quote the
256-byte figure. The JSON length wobbles across runs because Groth16 is randomised and field elements
are written in decimal; the wire form an on-chain verifier consumes is a fixed 256 bytes, inside 516
bytes of calldata together with the 8 public signals.

---

## 4. The statement that is actually proven

Given the six public field elements `(mHat, qHat, p0Hat, s, mmrHat, pLiqHat)`, all scaled by
`SCALE = 1e9`, the circuit proves:

1. every input is a non-negative integer inside an explicit bit bound (80/60/60/30/60);
2. `s` is exactly `+1` or `-1`; `mmr < 1`; `q ≠ 0`;
3. the integer residual `R = mHat·S² + s·qHat·(pLiqHat − p0Hat)·S − qHat·pLiqHat·mmrHat`
   satisfies `2·|R| ≤ qHat·(SCALE + mmrHat)`.

`R` is exactly `SCALE³ ×` (account value − maintenance requirement). The tolerance is **derived from
the inputs inside the circuit**, not a constant, so a prover cannot widen it without changing the
position being proven about. Measured over 1600 positions it is tight, not slack: tightest case
attains 0.999997 of the bound.

**How tight is that in practice?** Swept over 2400 positions: a verified proof pins `P_liq` to within
**1e-9 quote currency** of the canonical integer answer, and pins it to a *single* integer in 86.5%
of cases. A `P_liq` wrong by one 1e-9 step is rejected on the reference position.

---

## 5. What it does NOT establish — read this before writing any claim

### 5a. It does not certify the number the engine returned

The engine works in IEEE-754 doubles; the circuit works in integers. These are different
computations. Measured over 1600 scenarios, the engine's float `P_liq` and the canonical integer
`P_liq` agree to the last 1e-9 digit **only 70.8% of the time**, and the worst divergence is
**1.86e-4 quote currency**.

So: *a verified proof certifies the fixed-point restatement, not the engine's output.* Anyone writing
"the proof shows the engine computed correctly" is overclaiming by up to 1.9e-4.

There are two distinct error terms and **they must never be quoted as one number**:

- **encoding gap** (canonical integer vs. engine float): up to **1.9e-4** — *not* proven by the circuit.
- **residual bound** (circuit vs. canonical integer): **1e-9** — this is what the circuit proves.

If the team wants the first gap closed rather than merely disclosed, the fix is service-side: publish
the *scaled integers* as the canonical request representation and have the engine work from those.
Then the encoding gap is zero by construction. That is a change to the other session's code and this
track did not make it.

### 5b. It does not prove the position is yours

This is the big one. All six inputs are public and free, so an adversary picks any `P_liq` they like
and solves the identity for the margin that makes it true. **Measured, and the circuit accepts:**

| claimed `P_liq` | margin required | circuit |
|---|---|---|
| 60,000 | M = 20,150 | **ACCEPT** |
| 1 | M = 49,999.5025 | **ACCEPT** |

Residual is exactly zero in both — the identity genuinely holds. This is not a circuit bug. The
statement is *"these six numbers are mutually consistent"*, not *"these six numbers are your
position"*.

**Consequence for any integration:** verifying the proof is not enough. The six public signals must
be bound to something the verifier already trusts — a service signature over the request, or on-chain
state (an oracle price, a position NFT, a margin balance). **That binding is outside this artifact.**
A contract that verifies the proof and then acts on `pLiqHat` without checking where `mHat`, `qHat`,
`p0Hat`, `mmrHat` came from has verified arithmetic about numbers the prover invented.

### 5c. Phase 2 of the trusted setup has one participant, and it is this machine

Groth16 needs a two-part trusted setup, and the two parts are in very different shape here.

**Phase 1 is fine.** `build/pot12_final.ptau` is byte-for-byte the official Hermez / Polygon zkEVM
perpetual powers-of-tau file — a real public multi-party ceremony, the same one most circom projects
build on:

```
sha256 dcf4ea473bf14b971ce5f7b7c1d6ce1c41a8ed042cdb75b65ca9178e3a3c7c17
       == powersOfTau28_hez_final_12.ptau
```

**Phase 2 is not.** The circuit-specific contribution was made **once, by this session, on this
machine**. Whoever holds that secret can forge a proof of an arbitrary statement — including a false
liquidation price — and it will verify on-chain for 242,971 gas. That is the real limitation, and it
is narrower than "the setup is untrusted": it is precisely the per-circuit phase-2 contribution.

Fine for a hackathon artifact, disqualifying for real money. Production needs a genuine multi-party
phase 2, or a scheme with a universal setup (Plonk over an existing SRS) which removes the
per-circuit ceremony entirely. State this; do not let it be discovered.

---

## 6. Wiring it up

### Public signal order — get this wrong and valid proofs are rejected

snarkjs emits circuit **outputs before inputs**. The array is 8 long, not 6:

```
[0] residual R      [1] tolerance
[2] mHat  [3] qHat  [4] p0Hat  [5] s  [6] mmrHat  [7] pLiqHat
```

`verifyProof` takes `uint[8]`. This ordering is a property of the compiled circuit, not a convention.

### `residual` is signed, and the field is not — do not compare it naively

`residual` and `tolerance` are exposed deliberately so a verifier can see the slack actually used
rather than trusting that a bound existed. But `residual` is a **field element**, and **44.3% of
honest positions have a negative residual** (measured over 2400 positions).

A real verified proof, `{M: 0.00025, q: 0.001, P0: 0.5, s: +1, mmr: 0.001}`:

```
true residual                -250000000000000
publicSignals[0]             21888242871839275222246405745257275088548364400416034343698203936575808495617
publicSignals[1] (tolerance) 1001000000000000
```

The obvious check — `require(2 * residual <= tolerance)` — **rejects 44.3% of honest proofs**, since
2.19e76 is not ≤ 1.001e15, and it will look like a broken circuit rather than a misread signal. Map
back to signed first: if `residual > p/2`, the true value is `residual − p`. The circuit is correct;
it constrains `2R + tol ∈ [0, 2·tol]` precisely because the field has no order. This is a hazard for
code *reading* the signal, not for the proof.

### Cap the gas on the verifier call

Measured: rejecting a wrong *signal* costs 235,471 gas. Rejecting an off-curve proof *point* consumes
**98.5% of whatever gas you forward**, at every limit tested (1M → 985,282; 5M → 4,922,782), because
the failed pairing precompile eats it all. A caller that forwards all remaining gas will have none
left to handle the failure. Use an explicit gas cap on the `staticcall`.

### Use `exportSolidityCallData`

snarkjs's `pi_b` G2 coordinates are ordered differently from what the Solidity pairing check expects.
`snarkjs.groth16.exportSolidityCallData(proof, publicSignals)` does the swap. Hand-rolling it
produces a verifier that rejects valid proofs — a failure that looks like a broken circuit.

---

## 7. Honest prose for the technical document

> Quiver's computations are already verifiable by re-execution: clone the repo, check the engine's
> `codeHash`, re-run it on the echoed inputs, and compare. That property does not require a proof
> system and a SNARK does not strengthen it.
>
> What re-execution requires is a Node runtime. A smart contract does not have one, and today a
> contract consuming a Quiver result can only check a signature — which means trusting the signer
> rather than the computation. We close that specific gap for the flagship computation, the
> perpetual-futures liquidation price.
>
> We compile the liquidation identity `M + s·q·(P_liq − P₀) = q·P_liq·mmr` into a 667-constraint
> Groth16 circuit over BN254. Because circuits are integer systems and the engine uses IEEE-754
> doubles, the circuit proves a fixed-point restatement at 1e-9 scaling, with a residual bound
> derived from the position size rather than a fixed constant: `2|R| ≤ q̂·(SCALE + m̂mr)`. A verified
> proof pins the liquidation price to within 1e-9 of the canonical integer answer, and to a single
> integer in 86.5% of the positions we swept.
>
> Proving takes 242 ms and produces a 256-byte proof, constant in the size of the position.
> Verification takes 8 ms in JavaScript, or 242,971 gas on-chain against a 2,025-byte Solidity
> verifier.
>
> We state three limits plainly. First, the proof certifies the fixed-point restatement, not the
> engine's floating-point output; across 1600 scenarios the two agree exactly 70.8% of the time and
> diverge by up to 1.9e-4 quote currency. Second, the circuit has no private inputs — it buys
> succinctness, not privacy. Third, all inputs being public, the proof binds the six values to one
> another and not to any particular account; an integrator must bind them to trusted state
> separately. Our phase-1 setup is the public Hermez ceremony, but the circuit-specific phase-2
> contribution was made by a single party and is not suitable for production.

---

## 8. If someone picks this up with more time

In rough order of value:

1. **Bind the inputs to something.** Verify a service signature over the six values *inside* the
   circuit, or commit to the position and check the commitment on-chain. Without this, §5b stands and
   it is the weakest link.
2. **Close the encoding gap** by making scaled integers the canonical request representation
   service-side. Turns a 1.9e-4 disclosure into a non-issue.
3. **A real multi-party phase 2**, or move to Plonk over an existing universal SRS and delete §5c.
   Phase 1 already uses the public Hermez ceremony and needs no work.
4. **Formal check for under-constraint** (`circomspect`, or Ecne). The 53 negative cases here are
   evidence, not proof; they test the paths that were thought of.
