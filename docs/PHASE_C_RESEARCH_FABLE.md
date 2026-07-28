# Phase C, measured: aggregation is buildable, but not in this stack, and on this chain it saves five cents per hundred answers

**28 July 2026. Research, repo-only. Nothing built here is served, deployed, or on chain. Nothing
touches `hackathon/veritape/src/engine/`, so the published build hash does not move. Every number
below is either measured by running something today, read from a file or endpoint today, or labelled
an estimate. Scripts live in the session scratchpad, listed at the end; no project file other than
this one was written.**

The roadmap's Phase C paragraph makes four claims: that snarkjs has no recursion primitive, that
verifying a BN254 Plonk proof inside a BN254 circuit costs millions of constraints, that the ptau
file such a circuit needs runs to tens of gigabytes, and that Phase C is therefore a change of
proving stack. All four survive measurement. What does not survive is the premise underneath the
phase: on the chain where Quiver actually settles, the entire gas saving that aggregation exists to
capture is about five cents per hundred answers, and the roadmap's own abandon condition, evaluated
against today's numbers, is already met. The full case follows.

---

## 1. What the installed stack can and cannot do, measured

`snarkjs@0.7.6` as installed in `zk/node_modules` was enumerated by walking its export tree, not by
reading its README:

| namespace | functions |
|---|---|
| `groth16` | `fullProve, prove, verify, exportSolidityCallData` |
| `plonk` | `setup, fullProve, prove, verify, exportSolidityCallData` |
| `fflonk` | `setup, fullProve, prove, verify, exportSolidityCallData, exportSolidityVerifier` |
| `powersOfTau` | ceremony tooling (11 functions) |
| `zKey`, `r1cs`, `wtns`, `curves` | key/artifact utilities |

There is no aggregation, recursion, folding, or batch-verification primitive anywhere in the tree.
The roadmap's status note is confirmed on that point, but its "and nothing else" missed one thing:
**a complete `fflonk` namespace exists in the installed library**, and it works. Measured today on
the kelly circuit (718 Plonk constraints, domain 1024):

| | Plonk (deployed system) | fflonk (same snarkjs, same circuit) |
|---|---|---|
| setup with `hez_final_12` (2^12) | works | **refuses: "Powers of Tau is not big enough"** |
| setup with `hez_final_14` (2^14, 18.1 MB download) | not needed | works, 341 ms |
| prove, warm p50 | 355 ms | 427 ms |
| verify on chain, this EVM harness | **272,384 gas** | **194,198 gas** |

That is a measured **28.7% cut in per-proof verification gas with zero recursion, zero new trust
assumptions (same Hermez ceremony family), and zero new tooling**, at the price of one 18.1 MB file
per circuit rebuild. If any part of Phase C's motivation is per-answer gas, this is the first
tranche of it, available now inside the stack the roadmap says has nothing.

Also confirmed at source level: the snarkjs Plonk transcript is Keccak-256
(`node_modules/snarkjs/src/plonk_verify.js` line 24 imports `Keccak256Transcript`, used at line
211). This matters in section 4: any circuit that verifies an existing snarkjs proof must reproduce
that transcript in constraints.

Toolchain beyond snarkjs, from the ZK track's own probe (FINDINGS.md, 27 Jul): circom 2.2.3 as a
local exe, Node 24, no Rust, no cargo. Every credible aggregation route below needs Rust. That is a
real dependency change, not an npm install.

## 2. The gas shape of the done condition, measured in a real EVM

The done condition is: "100 answers verify in one transaction for less gas than 5 verify today; the
aggregate names the circuit ids it covers; a tampered member makes the aggregate fail."

The aggregation circuit does not exist, but the transaction it would produce does have a measurable
shape: one constant-cost pairing-based verify, plus calldata carrying the n answer sets, plus one
keccak binding them (the digest the real aggregate would take as public input), plus a scan that
reads every answer. That shape was built and executed today in `@ethereumjs/evm` (Cancun, solc
0.8.26, optimizer 200 runs), with the real kelly verifier standing in for the aggregate verifier and
a real kelly proof inside it. "tx" columns add the intrinsic cost (21,000 base + 16/4 gas per
calldata byte) to the measured execution gas, because a scheme that moves proofs into calldata
cannot ignore what calldata costs.

| call | execution gas | tx gas incl. calldata | calldata |
|---|---|---|---|
| 1 Plonk verify, direct (today's unit) | 272,384 | 306,460 | 932 B |
| aggregate shape, 5 answers | 267,335 | 309,139 | 2,276 B |
| aggregate shape, 20 answers | 270,280 | 334,452 | 6,116 B |
| **aggregate shape, 100 answers** | **286,932** | **470,464** | 26,596 B |
| aggregate shape, 1000 answers | 584,523 | 2,110,759 | 256,996 B |
| batch of 5 separate verifies, one call (the bar) | 1,329,119 | **1,415,815** | 4,772 B |
| batch of 20 separate verifies | 5,314,067 | 5,595,943 | 18,692 B |
| batch of 100 separate verifies | 26,567,136 | 27,889,984 | 92,932 B |

Findings, all measured:

- **The gas half of the done condition is arithmetically achievable with a 3.0x margin**: 470,464
  against the 1,415,815 bar, answers fully on chain and individually readable by the contract.
  Sensitivity to the stand-in: with a Groth16 wrap verifier (roadmap: 13% under Plonk) or the
  measured fflonk verifier (194,198), the aggregate transaction lands between roughly 390k and 505k,
  still under the bar in every variant.
- **Marginal cost per answer inside an aggregate: about 1,700 to 1,823 gas** (measured between the
  20/100 and 100/1000 points). Marginal cost per answer as a separate proof: 278,675 gas. The ratio
  is about 160x.
- **The title's "thousand answers" fails as literally stated**: 2,110,759 gas for 1000 on-chain
  answers exceeds the roadmap's own 5-proof bar. Calldata, not verification, is the binding
  constraint past roughly **620 answers** (derived from the measured fixed and marginal costs).
  Past that point the answers must leave calldata and become a commitment, which is exactly the
  existing `risk-attest` Merkle shape plus one proof over it. Recursion and the Merkle root are
  complements, not rivals: the scalable end state is "aggregate proof + root", with inclusion
  proofs on demand.
- **The tampered-member half of the done condition is not unique to recursion.** Gate B6's router
  already reverts the whole call on one bent leg (measured today in that gate's checklist), and a
  recursive aggregate gets the same property earlier, at proof construction. What recursion adds is
  that the 100 underlying proofs never need to be posted at all.
- The "names the circuit ids" half is a public-input design question (expose a commitment to the
  ordered vk set), supported by every route in section 6. The deployed `QuiverProofRegistry` is
  hardcoded to the liquidation shape (`uint256[8]`), so a batch entry point is new contract work in
  every scenario, including the no-recursion ones.

## 3. Why verifying a BN254 Plonk proof inside a BN254 circuit costs what it costs

The precise statement. A Plonk proof over BN254 verifies with two pairings and a handful of G1
scalar multiplications, all over BN254's **base field Fq**. A circom circuit constrains values in
BN254's **scalar field Fr**. Fq is not Fr (they differ near 2^254), so every Fq multiplication must
be emulated with multi-limb integer arithmetic, range checks, and carry handling inside Fr. That is
non-native field arithmetic, and it turns one field multiplication into hundreds of constraints and
one pairing into millions.

Evidence, strongest first:

- **Measured by others, directly on point**: `vocdoni/circom2gnark` verifies one circom Groth16
  BN254 proof inside a gnark BN254 circuit using gnark's emulated-pairing std library:
  **4,772,531 constraints, 14.7 s proving** on their hardware. Groth16 verification has no
  Fiat-Shamir transcript, so this is the floor for the easier of the two verifier types.
- **Measured by others**: `yi-sun/circom-pairing` (the circom pairing library, BLS12-381) requires
  a **2^24 ptau (about 16.8M constraint ceiling)** to build its pairing circuits at all.
- **Measured by others**: one Keccak-256 in circom costs about **150,848 constraints**
  (`vocdoni/keccak256-circom`; the eprint 2023/681 benchmark agrees at ~151k). The snarkjs Plonk
  transcript (confirmed Keccak-256 in source, section 1) hashes roughly a kilobyte across five
  challenge rounds, so the transcript alone is on the order of **1 to 2.5M constraints. Estimate.**
- Adding the pieces: one in-circuit snarkjs-Plonk verification lands around **6 to 12M R1CS
  constraints. Estimate, bracketed below by the 4.77M measured Groth16 datum.**

Now scale it to the done condition, using today's measured ptau ladder (HTTP HEAD against the
Hermez bucket, byte counts as served today):

| ptau | constraint ceiling | file size, measured today |
|---|---|---|
| 2^12 (on disk) | 4,096 | 4,801,688 B |
| 2^14 | 16,384 | 18,957,464 B |
| 2^16 | 65,536 | 75,580,568 B |
| 2^20 | 1,048,576 | 1,208,042,648 B |
| 2^22 | 4.19M | 4,831,921,304 B |
| 2^24 | 16.8M | 19,327,435,928 B |
| 2^26 | 67.1M | 77,309,494,424 B |
| 2^28 (`powersOfTau28_hez_final.ptau`) | 268M | 309,237,728,408 B |

- **A single-shot 100-proof aggregator (600M to 1.2B constraints, estimate) exceeds the largest
  ceremony file that exists for BN254.** 2^28 is the end of the Hermez ladder at 268M constraints
  and 288 GiB. This is structural for the one-circuit version, not an engineering gap.
- A tree of 2-to-1 aggregators fits under 2^25 per node, but the numbers are absurd in this stack:
  proving measured today at 0.33 ms per domain row in snarkjs (1,365 ms at 4,096), so a 2^25-row
  node extrapolates to about 3.1 hours in snarkjs, times 99 nodes per 100-leaf batch, and the zkey
  for one node alone extrapolates to about 74 GB at the measured 2.2 KB per row. With rapidsnark
  and native hardware (the roadmap's own Phase E figure: 20 to 40x) a node is minutes, a batch is
  the better part of a day of core-time. **All extrapolation, labelled as such, and all pointing
  the same direction: nobody aggregates by pairing-emulation inside circom, and this project should
  not either.**

The roadmap's sentence "millions of constraints against the 718 the Kelly circuit uses" is
therefore confirmed and can be sharpened to "about five to twelve million per inner proof, with a
measured 4.77M floor for the simpler verifier type".

## 4. The cycle-of-curves question, precisely

- **BN254 has no pairing-friendly cycle.** The only known pairing-pairing cycles (MNT4/MNT6) sit at
  about 750-bit fields, with security estimates near or below 100 bits, no EVM precompiles, and
  proving costs that ended their use even in the projects that pioneered them.
- **BN254 does have a half-cycle: Grumpkin**, whose base field is BN254's Fr and whose scalar field
  is BN254's Fq. Grumpkin is not pairing-friendly, so nothing KZG or Groth16 lives on it, but
  discrete-log commitments do, which is exactly the trick Nova/CycleFold exploits: do the one
  expensive non-native scalar multiplication per fold on the curve where it is native, and carry a
  tiny deferred instance instead of a pairing.
- **There is no production outer pairing curve over BN254's Fq** (no BW6-761 analogue as exists for
  BLS12-377). One-layer "verify BN254 natively in a bigger curve" is not on the menu; the menu is
  non-native emulation (section 3 prices it) or the Grumpkin folding route.
- FRI systems (plonky2/3, zkVM STARKs) get to pick their field and then pay the same non-native
  toll to talk to BN254, which they amortize with fast provers and a final BN254 wrap for the EVM.
  That is the honest description of what "use a modern stack" means: the toll is moved, not waived.

## 5. The four routes that actually exist, costed

| route | what it aggregates | stack change | prover cost per 100 answers | on-chain gas | new trust surface | exists today |
|---|---|---|---|---|---|---|
| **A. fflonk, no aggregation** | nothing (cheaper singles) | none (installed) | unchanged (427 ms/proof measured) | 194,198 per proof, measured | none (same SRS family) | yes, measured today |
| **B. zkVM aggregation (SP1 / RISC Zero)** | the existing snarkjs proofs | Rust; port the snarkjs Plonk verifier (keccak transcript, bounded work: the verifier is a few hundred lines) | minutes of GPU/large CPU; **benchmarks exist (NebraZKP proof-aggregation-benchmarks) but were not extracted here, evidence thin, measure before committing** | one wrapped Groth16/Plonk BN254 verify, ~280 to 330k + answers (estimate) | the zkVM's recursion circuits and its wrap ceremony | verifier port: no; everything else: yes, productized |
| **C. Folding re-proof (sonobe Nova+CycleFold, Nova-Scotia lineage)** | **the statements, not the proofs**: re-prove each answer's identity inside the fold | Rust; sonobe is 0.1.0-alpha, circom frontend marked experimental | per-answer step is the identity itself: all six live identities together are a **measured 3,689 R1CS**, plus ~30 to 50k augmentation overhead per step (estimate from sonobe's own decider formula), milliseconds native; decider ~10 to 12M constraint Groth16 per batch (derived from sonobe's published breakdown), minutes native | Groth16 verify + KZG + NIFS checks; **no published gas number found, estimate 400 to 900k** | sonobe alpha code, plus a circuit-specific Groth16 ceremony for the decider (the Phase E problem again, n=1 today) | library yes, this use no |
| **D. halo2 aggregation (snark-verifier / the Nebra UPA shape)** | KZG proofs via in-circuit accumulation, pairing deferred to the chain | Rust; either re-target circuits to halo2 or build a snarkjs-Plonk gadget (keccak transcript again) | tens of seconds to minutes on large hardware (public figures for the Axiom/Scroll lineage; not measured here) | UPA, deployed on Ethereum mainnet, publishes **~100k fixed + ~20k marginal per proof** at batch 32, "300k to 18k per proof" | none beyond the same Hermez SRS if self-hosted; Nebra as an operator if not | yes: UPA is a live commercial service for exactly this, Groth16 inputs only |

Three observations that fall out of the table:

- **Route C's central insight is the important one for Quiver**: aggregating proofs means paying 6
  to 12M constraints per answer to verify a verifier; re-proving the statements means paying about
  4k constraints per answer, because Quiver's statements are tiny closed-form identities. The
  ratio is three orders of magnitude, and it exists because Phase B did its job well. Any Phase C
  that starts from "fold the computation, not the proof" inherits it. The served per-answer proofs
  remain what they are today; the aggregate is a second, independent artifact over the same public
  signals.
- **Route D is the existence proof** that "one proof for many answers, verified on an EVM chain" is
  real, deployed, and commercial. It also quietly confirms the constraint arithmetic above: UPA
  batches 32, not thousands, and it charges for the prover.
- Route B is the least invention and the most outsourced trust. Route A is not aggregation at all
  and is still the best gas-per-engineering-hour on the board, measured.

## 6. The economics, against the abandon condition

The abandon condition: "aggregation costs more than it saves below 20 answers AND real usage never
batches that many. Measure before building the second half." Both halves were measured today.

Ground truth taken today: X Layer `eth_gasPrice` returned exactly **21,000,000 wei = 0.021 gwei**
(live RPC, block 66,342,323), confirming the 0.02 gwei figure gate B6 used. Ethereum L1
`eth_gasPrice` returned **0.0885 gwei**. Spot prices at time of measurement: OKB $85.33, ETH
$1,878.27 (CoinGecko). Dollar figures below are spot arithmetic on measured gas and are volatile;
the gas columns are the durable numbers.

| transaction | gas | X Layer cost | Ethereum L1 cost |
|---|---|---|---|
| 1 answer, own transaction | 306,460 | $0.000549 | $0.051 |
| 100 answers as 100 proofs | 27,889,984 | $0.0500 | $4.64 |
| 100 answers, aggregate shape | 470,464 | $0.000843 | $0.078 |
| **saving per 100 answers** | 27.4M | **$0.049** | **$4.56** |
| saving at n = 20 | 5.26M | $0.0094 | $0.88 |

Against the prover cost of producing the aggregate (route B: minutes of GPU; route C: a 10 to 12M
constraint Groth16 decider per batch, order $0.02 to $0.10 of cloud compute, estimate; route D:
similar or an operator's fee):

- **On X Layer the first half of the abandon condition holds at n = 20 for every route** (saving
  $0.0094, and no route's prover run costs less than that), **and holds at n = 100 for every route
  except possibly folding**, where $0.049 of saving against an estimated $0.02 to $0.10 decider run
  is a coin flip. Aggregation on this chain is not an economic instrument; at best it breaks even.
- On Ethereum L1 at today's spot the picture flips: $4.56 saved per 100 answers clears any
  plausible prover cost for routes C and D. Quiver does not settle on L1 today.
- The second half: the roadmap's own Phase F figure is six external payers and 44 payments over
  eight days, about 5.5 calls per day across all buyers. **Nobody batches 20 answers, because
  nobody produces 20 answers.** Met as of today, with the honest caveat that the condition was
  written to be evaluated after Phase B ships circuits people buy, and today is before that.

**Both halves of the abandon condition, as written, are satisfied on today's numbers.** The
condition's own instruction ("measure before building the second half") has now been executed, and
the measurement says: do not build yet.

One number cuts the other way and deserves its own line. An agent genuinely polling at 1 Hz and
posting every answer would pay about **$47 per day on X Layer** (measured per-tx cost times
86,400); the same agent checkpointing aggregates of 100 would pay about **$0.73 per day**. If such
an agent existed, aggregation would be worth 65x to it, and folding is the only route whose prover
cost does not eat the difference. No such agent exists in today's usage. At one poll per minute the
own-transaction cost is $0.79 per day, and there is nothing to save.

## 7. Is Phase C the right answer to the problem it names?

The phase opens: "An agent polling risk in a loop cannot put each answer on chain, and does not
want to." Split it:

- **"Cannot" is false at any realistic polling rate below about one per second**, measured: an
  answer costs $0.00055 to put on chain today. At 1 Hz it becomes $47/day, which is real, and that
  is the one scenario where aggregation genuinely changes the product's unit economics.
- **"Does not want to" is a throughput and nonce-management complaint**, and it is solved without
  any cryptography by a relayer that batches transactions, or by the existing `risk-attest` Merkle
  batching, which already gives per-answer on-chain commitments for one root. What the Merkle root
  does not give is correctness, exactly as the roadmap says.
- So the surviving question is: **who pays for on-chain correctness of history in bulk?** Not the
  acting agent (it needs the latest answer, one proof, 306k gas, today). The buyer of correct
  history is retrospective: an insurer, a slashing mechanism, an auditor of an agent's whole run,
  or a buyer on an expensive chain where per-answer verification is priced out. Those are Phase F
  outcomes, none contracted today. Phase C is sequenced before its own demand.

## 8. What aggregation would NOT achieve

Stated plainly, because the phase title invites overreading:

- **It does not touch the input problem.** One hundred proofs about caller-supplied inputs fold
  into one proof about caller-supplied inputs. Every limitation measured in the liquidation track
  (any P_liq is provable for the right margin) passes through aggregation intact. Phase D is
  untouched.
- **It does not reduce latency; it adds some.** Per-answer proving stays on whatever path it is on
  (measured 355 to 1,365 ms per circuit today), and the last answer of a batch additionally waits
  for the aggregate prover: minutes for every credible route. An agent that needs the newest answer
  proven fast is served worse by batching, not better.
- **It does not remove the answers from calldata** for any consumer that needs to read them, and
  past the measured ~620-answer ceiling the answers must move off chain into a commitment anyway,
  at which point per-answer availability is back to inclusion proofs against a root.
- **It does not preserve the zero-new-trust story for free.** Route B imports the zkVM's recursion
  circuits and wrap ceremony; route C imports alpha library code and needs a circuit-specific
  Groth16 ceremony for its decider, which is precisely the Phase E social problem the roadmap has
  refused once already; route D self-hosted is the cleanest (same Hermez SRS) and the most
  engineering. "One transaction" is bought with somebody's setup.
- **It does not make the tampered-member property new.** The B6 router already refuses a batch with
  one bent leg, measured. Aggregation moves the refusal earlier and off chain, it does not create it.
- **It does not sell itself.** The measured saving on the deployed chain is $0.0005 per answer.
  Nothing in this document creates a buyer for bulk correctness; it only prices one.

## 9. Verdict against the roadmap's own conditions

- **Done condition, gas half: achievable, measured, with a 3.0x margin at 100 answers** (470,464
  against 1,415,815), on chain answers included, under every plausible verifier stand-in. At 1000
  answers as literally titled: not achievable with on-chain answers (2,110,759 exceeds the bar);
  achievable only as aggregate-plus-root.
- **Done condition, prover half: not achievable inside snarkjs/circom, structurally** (single-shot
  needs more constraints than the largest BN254 ceremony file supports; the tree version extrapolates
  to hours per batch and tens-of-GB proving keys). Achievable with a stack change, three concrete
  shapes in section 5, of which folding-over-statements (C) is the one aligned with what makes
  Quiver's circuits special, and zkVM aggregation (B) is the least engineering risk. The roadmap's
  "it is a change of proving stack" is confirmed, and its two-month estimate remains an estimate
  for the work after the stack is chosen and Rust is on the box.
- **Abandon condition: met, today, on the deployed chain, both halves** (saving below prover cost
  at n = 20 for every route; usage 5.5 calls/day, nobody batches). The honest disposition is not
  "abandon forever": it is **defer until one of three things changes: the chain (L1 flips the
  economics 90x at spot), the frequency (a real 1 Hz poller appears), or the buyer (someone pays
  for bulk history)**. Each is observable, none is true now.
- **What contradicts the roadmap's framing, found by measurement:** the installed snarkjs is not
  bare of relevant primitives (fflonk works and cuts per-proof gas 28.7%, measured end to end
  today); the gas motivation does not survive contact with X Layer's measured gas price; and the
  phase's strongest available implementation (fold the statements) does not aggregate the existing
  proofs at all, it re-proves the answers, which quietly redefines what "one proof for a thousand
  answers" means: not compressing the proofs Quiver already sold, but proving the catalogue's
  arithmetic in bulk. The roadmap should say which of the two it wants, because they are different
  products with different trust stories.

## Files

All scratchpad, session-local, nothing written into `zk/` or served code:

| | |
|---|---|
| `scratchpad/facts-all.mjs` | reads every circuit's real size from its artifacts (table in section 3 context: kelly 372/718, liquidation 667/1301, concentration 451/834, divergence 463/887, constantproduct 671/1293, greeks 1103/2152, greeksfp 1065/1919, greekssigned 1952/3615, padprobe 3900/3902 R1CS/Plonk) |
| `scratchpad/agg-shape.mjs` | the section 2 measurement: aggregate shape vs batch counterfactual in `@ethereumjs/evm`, intrinsic calldata accounting included |
| `scratchpad/fflonk-probe.mjs` | fflonk end to end: 2^12 refusal, 2^14 setup, prove timing, exported verifier at 194,198 gas |
| `scratchpad/hez_final_14.ptau` | 18,957,464 bytes, sha256 `489be9e5ac65d524f7b1685baac8a183c6e77924fdb73d2b8105e335f277895d` |
| `zk/scripts/domain-scaling.mjs` (existing, re-run) | 355 ms at 1024, 755 ms at 2048, 1,365 ms at 4096; exponent 0.97 this run against 1.01 recorded earlier, both consistent with ~linear |

External sources relied on for numbers not measurable here:
[circom2gnark](https://github.com/vocdoni/circom2gnark) (4,772,531 constraints, 14.7 s),
[circom-pairing](https://github.com/yi-sun/circom-pairing) (2^24 ptau requirement),
[keccak256-circom](https://github.com/vocdoni/keccak256-circom) and
[eprint 2023/681](https://eprint.iacr.org/2023/681.pdf) (~151k constraints per Keccak-256),
[sonobe](https://github.com/privacy-ethereum/sonobe) and its
[onchain decider docs](https://sonobe.pse.dev/design/nova-decider-onchain.html) (decider breakdown,
~11.9M constraints for a 500k step),
[SnarkPack](https://eprint.iacr.org/2021/529.pdf) (Groth16-only, two independent ceremonies, 8192
proofs verified in 163 ms off chain),
[Nebra UPA gas docs](https://docs.nebra.one/developer-guide/gas-costs-on-l1s) and
[UPA gas blog](https://blog.nebra.one/upa_gas/) (~100k fixed + ~20k marginal per proof, batch 32),
[NebraZKP proof-aggregation-benchmarks](https://github.com/NebraZKP/proof-aggregation-benchmarks)
(zkVM aggregation comparisons, numbers not extracted),
[SP1 bn254 precompiles](https://blog.succinct.xyz/succinctshipsprecompiles/),
[snark-verifier](https://github.com/privacy-scaling-explorations/snark-verifier),
[Hermez ptau bucket](https://storage.googleapis.com/zkevm/ptau/) (all file sizes HTTP-HEAD measured
today).

Nothing is served. No aggregate exists. The deployed verifier, registry, and every number they
carry are exactly what they were this morning.
