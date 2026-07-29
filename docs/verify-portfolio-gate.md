# portfolio-gate: the leg ceiling, verified and then removed

Every number below was computed on 2026-07-29/30 on this machine and is reproducible with the commands
shown. Nothing is quoted from a note.

**Verdict: buildable-and-built.** The reported blocker held as arithmetic and was refuted as a
blocker. A 4-leg build does need a ceremony file that is not on disk — but raising the ceremony was
the wrong lever, and the ceiling is gone without it. An 11-leg book is now proved, verified on chain,
and gated, using only `hez_final_12.ptau`, which was already there.

---

## 1. The constraint counts, reproduced

Compiled fresh into a scratch directory so the existing artifacts were not disturbed, then read back
out of the `.r1cs` files with snarkjs.

| shape | non-linear | linear | R1CS total | Plonk | domain | ptau needed |
|---|---|---|---|---|---|---|
| `portfoliogate` N=3 | 1,989 | 64 | **2,053** | **3,970** | 4,096 | 2^12 |
| `portfoliogate4` N=4 | 2,652 | 84 | **2,736** | **5,295** | 8,192 | 2^13 |
| `portfolioleg` 1 leg | — | — | **651** | **1,267** | 2,048 | 2^11 |

The main agent's figures reproduce exactly at both N=3 and N=4. `circom --version` is 2.2.3.

**The linear/non-linear trap.** circom prints two separate lines and snarkjs's `nConstraints` is their
sum. 1,989 + 64 = 2,053 and 2,652 + 84 = 2,736, both confirmed against `snarkjs.r1cs.info`, so the
totals are the sum and not either line alone.

**One number in the brief was wrong, and in the direction that matters.** The brief said a 4-leg build
"wants roughly 5,290 Plonk and domain 8,192". The Plonk count is **5,295**, not approximately 5,290 —
and it is not an extrapolation from the N=3 expansion ratio. snarkjs was asked to do the setup and the
count was read out of its own gate generation:

```
$ node node_modules/snarkjs/build/cli.cjs plonk setup build/portfoliogate4.r1cs build/hez_final_12.ptau /tmp/pg4.zkey
[INFO]  snarkJS: Plonk constraints: 5295
[ERROR] snarkJS: circuit too big for this power of tau ceremony. 5295 > 2**12
```

The domain is 8,192, so the file needed is **2^13**, not 2^14. snarkjs sizes with
`cirPower = log2(n-1) + 1` where its `log2` is a **floor**; I first wrote `Math.ceil` and got 2^14 /
domain 16,384 — one clean power out, exactly the shape a wrong exponent has. The gate now checks the
derived domain both holds the circuit and that half of it would not.

## 2. What the ptau actually costs — measured, not quoted

`curl -sIL` against the official Hermez ceremony bucket, the same source the file on disk came from
(`zk/FINDINGS.md` records `hez_final_12` as byte-for-byte the public file):

| file | Content-Length | what it buys |
|---|---|---|
| `powersOfTau28_hez_final_12.ptau` | 4,801,688 B (4.58 MiB) | on disk already — 3 legs |
| `powersOfTau28_hez_final_13.ptau` | **9,520,280 B (9.08 MiB)** | 4 legs |
| `powersOfTau28_hez_final_14.ptau` | 18,957,464 B (18.08 MiB) | 5 legs |

So the brief was right that this is a download and not a structural wall, and right that 14 is ~18 MB.
It was wrong about which file is needed: **2^13 at 9.08 MiB suffices**, and 2^14 is one power more
than the problem requires.

**I did not fetch it.** Two reasons, and the second is the one that matters:

1. Downloading a file is not something I can authorise on an agent's instruction — that needs Tristan
   in the loop. The exact command is at the end of this document if he wants it.
2. **It became unnecessary.** A 2^13 ceremony buys leg number four. The service accepts an unbounded
   number of legs and its own tests exercise eleven. Buying one leg against a gap of eight, at the
   cost of a doubled evaluation domain, is a real answer to the wrong question.

## 3. How many legs does the service actually accept?

**No cap at all.** `maxItems` appears **zero** times in the tree (counted with `wc -l`, not eyeballed
off a truncated grep). The only bound anywhere is a lower one — `portfolioGate.js:87`,
`if (!positions.length) return { ok: false, ... }`. Every other `positions.length` reference in
`src/`, `api/` and `sdk/` (21 hits, all inspected) is a liveness or reporting read, never a ceiling.

So the gap being described is not 3-vs-4. It is 3-vs-unbounded, and gateB6's 11-leg book is simply the
largest one the test suite happens to use.

## 4. The shape that removes the ceiling

`portfoliogate.circom`'s own header states the claim as two claims:

> (1) the named leg satisfies the liquidation identity in its own right, and so does every other leg
> […] and (2) no other leg is nearer.

(1) is per-leg and independent. (2) is a comparison between numbers. **If each leg's proof publishes
the two integers its distance is the ratio of, then (2) is arithmetic over public values and can be
done by whoever is reading — including a contract.** n legs is then n independent proofs at a fixed
domain plus a cross-multiplied minimum, and there is no domain ceiling at any n.

### The soundness question, answered honestly

Per-leg proving loses **nothing** relative to the wide circuit. Neither shape proves the book is
*complete*: `portfoliogate.circom`'s legs are public inputs, so a prover who omits the leg that is
actually nearest gets a true statement about the legs it did submit — exactly as here. Book
completeness is the input problem (an exchange-attested read), which `QUIVER_ROADMAP_V2.md` already
names as the honest end of this road, and it is untouched either way. Nor is anything additional
disclosed: `d` is derivable from `refHat` and `pLiqHat`, both of which the wide circuit already
publishes.

What per-leg proving does cost is **gas**, and that is measured below rather than argued.

### The defect this found in gateB6

gateB6 measured this exact trade and concluded Route B works. Its router ranks on
`signals[i][PRICE_INDEX]` with `PRICE_INDEX = NPUB - 1`, which for `liquidation.circom` is `pLiqHat` —
**the liquidation price**. `portfoliogate.circom`'s header says in as many words that this is a
different answer:

> Ranking on the liquidation PRICE instead — which is what gateB6's on-chain router does — is a
> different answer entirely.

The engine ranks on `moveToLiqPct` (`portfolioGate.js:107`), the adverse move from the mark. On
gateB6's own eleven-leg book the two disagree:

| ranking | leg named | distance | liquidation price |
|---|---|---|---|
| distance ratio `d/ref` (engine's) | **10** | **6.1033%** | $300.47 |
| liquidation price (gateB6's) | 3 | 24.0891% | $0.4706 |

gateB6 did not measure the portfolio minimum. It measured a price minimum, on a book where that names
a leg four times further from liquidation than the binding one. Route B was the right shape reached
through the wrong comparison.

## 5. What was built

**`zk/circuits/portfolioleg.circom`** — one leg, proving the liquidation identity and publishing
`(d, refHat)` so the ranking can be taken outside. 651 R1CS / **1,267 Plonk** at domain **2,048**.

Two things worth noting about that number:

- It is **smaller than `liquidation.circom`'s own 1,301 Plonk** while proving strictly more (it adds
  the mark and the adverse distance). The tolerance re-expression — two `NB_TOL`-bit decompositions
  instead of `Num2Bits(160)` + `LessEqThan(160)` — saves more than the two new range checks cost.
- It runs at **full parity with `liquidation.circom`'s original bit widths**, which three legs in one
  domain could not afford. The 3-leg circuit had to narrow margin to 2^60, size to 2^55 and price to
  2^50, and those narrowings are *refusals*. Per-leg restores margin 2^80, size 2^60, price 2^60. So
  the per-leg route is wider not only in legs but in every leg.

**`zk/scripts/lib/portfolio-perleg.mjs`** — the encoder. The per-leg encoding is *not* rewritten: it
comes from the service's own `util/snark.js:witnessFor` via `portfolio-witness.mjs`, carrying the
margin recomputation, the grid snap and the canonical integer solve. gateB6 hand-rolled an encoder and
had all eleven legs refused by the constraint system; that mistake is not repeated here. Both service
divergence guards are kept (half a cent on price, 0.0005 on the ranked distance), as is the
ordering-split refusal.

**`zk/scripts/gateB10-portfolio-perleg.mjs`** — the gate. In-process EVM, nothing deployed.

## 6. Measured results

11 legs, `PortfolioNearestRatio` verifying every proof then taking the cross-multiplied minimum, each
row in a **fresh EVM** (sharing one instance makes every row after the first 7,500 gas cheaper for
free under EIP-2929, which would flatter exactly the curve being judged):

| legs | gas | gas/leg |
|---|---|---|
| 1 | 276,448 | 276,448 |
| 3 | 815,487 | 271,829 |
| 4 | 1,086,248 | 271,562 |
| 6 | 1,625,200 | 270,867 |
| 8 | 2,161,535 | 270,192 |
| **11** | **2,968,446** | 269,859 |

Against the wide 3-leg verifier's **291,708** gas (read out of `gateB8-2-portfolio-evm.json`, not
written down): 11 legs costs **10.2x** what three legs in one proof cost. That is the price of the
reach. The brief's recalled figure of 2,941,443 for gateB6's 11-leg route is not what
`gateB6-portfolio-routes.json` holds either — that file records **2,944,135**.

**Latency, both sides measured in the same process on the same three legs**, because a comparison
against a figure from another day's run is a comparison across two machine states:

| | prove |
|---|---|
| wide circuit, one proof, domain 4,096 | 1,634 ms |
| three per-leg proofs, domain 2,048 | 2,220 ms serial · **742 ms parallel** |
| eleven per-leg proofs, domain 2,048 | 8,228 ms serial · **793 ms parallel** |

So eleven legs in parallel is *faster in wall-clock* than one wide proof of three — Plonk pays for the
domain, and the per-leg domain is half. The honest other half: 8,228 ms is more total prover work than
1,634 ms, so the parallel figure is a claim about a prover that actually runs eleven workers. Both are
asserted in the gate.

**Refusal rate**, 200 synthetic books per size, encodability only:

| legs | books accepted | legs refused | ordering splits |
|---|---|---|---|
| 4 | 195/200 (97.5%) | 5 / 800 | 0 |
| 6 | 192/200 (96.0%) | 8 / 1,200 | 0 |
| 11 | 189/200 (94.5%) | 14 / 2,200 | 0 |

Every refusal was `divergedPct` — the certified distance drifting past the 0.0005 the service publishes
`moveToLiquidationPct` at. **Not one was a bounds refusal**, which is the wider bit widths earning
their place. The wide route's acceptance at all three sizes is 0%, by construction.

## 7. The gate can fail

A verifier that cannot fail is the disease. This one was caught failing three times:

1. **Organically, twice.** The first version wrapped `plonk.setup` in a try/catch to read the N=4
   count. `plonk.setup` does not throw when a circuit will not fit — it logs the count and **returns
   -1** — so the check passed while measuring nothing. It now captures a logger and asserts on the
   `-1`. The `Math.ceil` exponent error in §1 was the second.
2. **Deliberately.** `B10_REVERT=price` swaps the router's comparison for gateB6's:

```
$ B10_REVERT=price node zk/scripts/gateB10-portfolio-perleg.mjs
  !! REVERT MODE: router ranks on the liquidation PRICE, as gateB6 did. The gate must fail.
  [*** FAIL ***] the contract names the leg the ENGINE named, ranking by ratio on chain
GATE B10: FAILED
  exit 1
```

The ratio comparison is load-bearing, and the gate proves it by breaking when it is removed.

Refusals that are asserted, not summarised: all 10 public signals perturbed one at a time and rejected
off chain; a bent proof point sinking the whole eleven-leg answer on chain; and the attack this router
specifically must stop — **a forged distance signal on a safe leg, claiming `d = 1` to win the
ranking, reverted** because the proof no longer matches its signals.

## 8. What is not verified

- **The 2^13 build itself.** No 4-leg zkey was produced, because the ceremony file was not downloaded.
  The 5,295 / 8,192 / 2^13 figures are measured; proving time at domain 8,192 is not, and I have not
  extrapolated it. `domain-scaling.mjs` fits an exponent from three points and labels anything past the
  file on disk as extrapolation; I have not added a fourth claim on top of that.
- **Book completeness**, in either shape. See §4.
- **The refusal sweep is synthetic.** 200 books per size from a seeded generator over a realistic price
  ladder — not the live venue universe. `gateB8-1` is the gate that samples the real engine.
- **Gas is one sample per row.** `probe-plonk-gas-variance.mjs` measures a 1.26% spread across proofs
  of an identical statement, so the 10.2x ratio has at least that much slack in it.

## 9. If the ceremony file is wanted anyway

It is not needed for anything above, and a 4-leg circuit is strictly worse than the per-leg route on
reach, on input domain and on wall-clock latency. But the download is one command, and its size is
known:

```
curl -o zk/build/hez_final_13.ptau \
  https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_13.ptau      # 9,520,280 bytes
```

`build-circuit.mjs` hardcodes `hez_final_12.ptau` and a 4,096 ceiling, so it would need a parameter
before it could consume that file. That is a deliberate refusal in its own comment — "fetch a larger
powers-of-tau file deliberately, not as a side effect of a build" — and I have left it intact.

---

### Reproduce

```
node zk/scripts/gateB10-portfolio-perleg.mjs              # the gate            -> PASSED, exit 0
B10_REVERT=price node zk/scripts/gateB10-portfolio-perleg.mjs   # prove it fails -> FAILED, exit 1
node zk/scripts/build-circuit.mjs portfolioleg            # rebuild the circuit
```

Artifact: `zk/build/gateB10-portfolio-perleg.json`.
