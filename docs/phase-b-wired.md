# Two more engines serve proofs: what was on the wrong side of the fence, and what those proofs still do not say

**Written 29 July 2026.** Follows `QUIVER_ROADMAP_V2.md` §"Phase B", whose status line said one of six
circuits was done and five were unstarted. By the time anyone re-read it all six had circuits, and the
number that had stopped moving was a different one: how many engines a CALLER can obtain a proof from.

That number was one. It is now three. Everything below is measured.

| | result |
|---|---|
| the gap, reproduced before touching anything | `src/util/snark.js` opened *"Succinct proofs for the liquidation identity"* and held one circuit |
| encoders already working, on the wrong side | 3 files under `zk/scripts/lib/`, each proven by a gate that built its own witness |
| engines reachable for a proof, before | 1 of 22 — `perp-gate` |
| engines reachable for a proof, after | 3 of 22 — `perp-gate`, `size-gate`, `treasury-risk` |
| worst honest bet's use of the Kelly bound | **99.998%** of it, over 18,540 bets against the real engine |
| worst honest book's use of the Herfindahl bound | **94.671%** of it, over 8,000 books against the real engine |
| cases exceeding either bound | 0 |
| gate K | 8 of 8 PASS, offline |
| gate H | 7 of 7 PASS, offline |
| gate K revert | 6 of 6 turn it red, naming the right assertion; green again after |
| gate H revert | 5 of 5 turn it red, naming the right assertion; green again after |
| pinned `size-gate` and `treasury-risk` content hashes | all unmoved, on both surfaces, with and without the flag |
| Appendix C | `8575ce5ae5bfae9c…` unmoved; liquidation retrieval shape unmoved to the key |
| engine build hash | `q1-e1fa99d08887d6cc`, unmoved — `src/engine/` untouched |
| `npm test` | 386 |
| `node gates/preflight.mjs` | PASSED |

---

## 1. What was actually in the way

Not the circuits. All six existed. `zk/circuits/` holds `kelly`, `portfoliogate`, `constantproduct`,
`divergence`, `concentration` and the `greeks` family, each with a compiled proving key, a generated
Solidity verifier and a gate under `zk/scripts/` that proves, verifies and refuses.

What was in the way is that every one of those gates builds its **own witness**. `gateB0-kelly.mjs`
carries a private `encode(p, b)` function. That establishes a property of `kelly.circom` and a property
of the script sitting beside it, and nothing whatsoever about the product — a caller cannot reach
either. The service's own witness builder, `witnessFor` in `src/util/snark.js`, built a liquidation
witness and returned `null` for anything else.

So the fence ran between `zk/` and `src/`, and six circuits were on the far side of it. Moving one
across is what this document records.

The distinction is easy to state and easy to lose: a circuit that has been proven correct is not a
service that serves proofs. `zk/scripts/gateB1-kelly-sweep.mjs` has passed since 28 July over 4,000
bets with zero violations. In that entire time no `size-gate` response carried a proof, and no reader
of the roadmap's status line would have learned that from it.

---

## 2. The bound is derived, and deriving it is most of the work

The tempting version of this change is four lines: import the encoder, call the prover, attach a
sibling. That version ships a proof of a bet nobody asked about.

`src/util/snark.js` refuses to publish a proof whose witness disagrees with the answer that was
served, and the bound it refuses on is assembled from roundings that actually happen. For the
liquidation identity those are `round(pLiq, 2)` and a half grid step. **Neither transfers.** The Kelly
fraction is published as `round(f*, 6)` — ten thousand times finer — so the price guard's half-cent
would have admitted a fraction five hundred grid steps from the one that was served, waved through by
a tolerance that was correct about a different number.

So the Kelly guard has its own constants, its own display rounding, and its own encoding shift. Four
questions are asked before anything is proved, each with its own refusal so the stored record says
which one failed:

1. **Is there a positive edge to certify?** A continuous-mode answer states `f* = mu/sigma^2`, which
   `kelly.circom` has no term for; a non-positive edge is a region the engine declines to size and the
   circuit excludes at its boundary. Both are refused by name rather than by silence.
2. **Does the witness size the bet the engine sized?** Asked as an EQUALITY against the engine's own
   display rounding — the recomputed fraction, rounded the way the engine rounds it, must be the
   number that was served — rather than as a tolerance. This is the whole of what any tolerance could
   detect, and asking it as an equality means the boundary case that once refused RUNE a liquidation
   proof cannot arise here.
3. **Can the 1e-9 grid pin this bet at all?** The fraction is `(1-p)/b²` sensitive in the odds, so
   below roughly `b = 0.002` a half step of the odds moves it further than the 5e-7 the answer is
   displayed to. A proof whose certified fraction could sit a whole displayed unit from the answer is
   not a proof of the answer, however honest its arithmetic.
4. **Does the circuit's integer solve agree with the engine's own unrounded fraction?** Grid
   resolution, not display resolution: 5e-10 on every served path against the 5e-7 the display alone
   would allow.

A fifth check costs two BigInt multiplications and turns an unsatisfiable-constraint failure deep
inside the witness calculator into a refusal that names the residual: `2|R| <= b̂`, the circuit's own
statement, verified on this side first.

### The shift is measured over a box, not differentiated

`f = (p(b+1) - 1)/b` is monotone in `p` at fixed `b`, and monotone in `b` at fixed `p`. A function
monotone in each coordinate separately attains its extremes over an axis-aligned box at the box's
CORNERS, so all four are evaluated and the largest excursion is the bound. No derivatives are taken,
and that is not stylistic: a first-order sensitivity sum is the natural way to write this and it is
what failed on 153 of 357,138 liquidation positions, at sizes near the grid step itself where a
half-step perturbation is a third of the value and Taylor says nothing.

### And the bound is tight

A bound the worst honest case cannot approach is not measuring anything. Measured over 18,540 bets run
against the real engine in four deliberately different shapes:

| | measured |
|---|---|
| bets exceeding their bound | 0 |
| worst publishable bet's use of the bound | 99.998% |
| median use | 35.25% |
| p99 use | 96.69% |
| bound on the served (snapped) shape | 5.00e-10, exactly 1.00× the single grid rounding |
| bets refused as unpinnable | 1,790, every one off-grid with odds in [1.00e-4, 1.99e-3] |
| snapped bets refused as unpinnable | 0 of 5,000 |

The last two rows are the ones worth reading together. On the served path the handler snaps first, so
the encoding error is half an ulp instead of half a step and the bound collapses to one grid rounding
— every bet a caller can actually be served is provable. The refusals all come from off-grid shapes,
which `kellyWitnessFor` must still be sound for, because it is exported and called directly.

---

## 2b. The third circuit, and the defect only it invites

`treasury-risk` proves the Herfindahl identity, and it is the first circuit here whose inputs are not
the caller's. `kelly.circom` takes a probability and a ratio, both typed by whoever asked.
`concentration.circom` takes the SHARES — and the shares are something the engine made, by grouping
the book by asset, summing each group, and dividing by the total.

**Two consequences, and both shape the whole wiring.**

**The grouping must be the engine's.** A book with two USDC positions has ONE USDC share. An encoder
that forms one share per POSITION is the natural thing to write; it produces a well-formed witness,
proves against it, verifies, and describes a book with a lower concentration than the one that was
priced, agreeing with itself perfectly the entire time. Nothing under `zk/` would have caught it: the
sweep that proves the circuit re-derives weights per position too, and is sound only because its own
generator gives each asset exactly one position. Gate H is built the other way round — 4,928 of its
8,000 books repeat an asset — so the mistake dies on the first one. It is revert 1.

**No snap can put a quotient on the grid.** `vᵢ/T` lands where the division lands however carefully
the request was written, so the guard's encoding term carries a full half step per share rather than
the half ulp a snapped input costs. That is the same situation as the liquidation margin derived from
leverage. The shift is measured over all 2^N corners of the encoding box — N is at most eight, so 256
evaluations of a sum of eight squares, which costs nothing and avoids a separability argument that
would have to be right.

| | measured |
|---|---|
| books, against the real engine | 8,000 |
| of those, repeating at least one asset | 4,928 |
| encoded with a share count that is not the engine's group count | 0 |
| exceeding the bound | 0 |
| worst honest book's use of the bound | 94.671% |
| median bound | 1.50e-9, three times the single grid rounding |
| the display half-unit it is measured against | 5e-5 |
| books refused as unpinnable | 0 |

The last two rows are the shape of this circuit: the index is displayed to four decimals and the
encoding moves it by nanometres, so the "can the grid pin this" question never fires and the
same-answer equality does all the work. The sweep gate under `zk/` compares at four decimals against a
5e-5 threshold and measured its worst honest book at 4.9991e-5 — 99.98% of the threshold consumed by
display rounding alone, which is a threshold about to start refusing honest books. Asking the question
as an equality against the engine's own rounding removes the threshold rather than widening it.

**A ninth asset is refused by name, with the count.** The circuit is compiled for eight. A book with
fewer pads with zero shares, which contribute nothing to either accumulator and are still range-checked
by the circuit, so a pad is a genuine zero rather than a hole a prover can fill. A book with more has
no such escape: the ninth share is real rather than absent, so padding cannot help and the refusal says
so. Eight exactly still proves, and gate H asserts both sides of that boundary.

**And one dimension of three is proven.** `byVenue` and `byChain` are computed by the same code and
published beside `byAsset`. Neither is in the proof, and the response says which one is.

---

## 3. Where the grid goes, and why exactly two fields

`gates/preflight.mjs` requires that any handler building a Plonk proof snaps its inputs onto the grid
the circuit works over, on BOTH surfaces. The interesting decision is not whether to snap but WHAT.

`size-gate` snaps `winProb` and `winLossRatio`, and nothing else. `kelly.circom` has terms for `p` and
`b` and for no other quantity, so `bankroll`, `kellyFraction` and `drawdownLevels` are left exactly
where the caller put them. Snapping a field no circuit can see would move a content hash and buy none
of the property the grid exists for. The continuous-mode pair is untouched for the same reason.

Compare `perp-gate`, which snaps eight fields including `leverage` — a quantity the liquidation circuit
also has no term for. That one is snapped because the engine DERIVES margin from it and the quotient
lands off-grid otherwise. Each list is a decision about that circuit, which is why the proof-emitting
set in `gates/preflight.mjs` is written out by name rather than counted:

```
check('the proof-emitting set is the one that has been checked',
  JSON.stringify(emitting) === JSON.stringify(['http:perp-gate', 'http:size-gate', 'mcp:perp_gate', 'mcp:size_gate'].sort()),
```

Four entries, so a surface silently contributing nothing turns it red. That check exists because it
once collapsed to `[mcp:perp_gate]` alone when a wrapper blinded it, and reported "every service that
builds a zk proof snaps" over a set it could no longer see.

Preflight also gained a check that each circuit's artifacts are actually in the build. A handler
emitting a proof against a key the deploy does not carry fails inside a worker, on a background path
nobody is waiting on: the record lands as `failed` and the caller polls a `building` that never
finishes.

---

## 4. What is returned, and what it is careful not to claim

The proof covers `fullKellyFraction`. It does not cover the number this service leads with.

`recommendedBetFraction` is `kellyFraction × f*`, and the circuit has no term for `kellyFraction`. So
the proof certifies the CEILING that the recommendation is a fraction of, and the response says so in
as many words rather than leaving a reader to infer the scope from a field name:

> **proves** — The discrete-Kelly identity over the three integers pinned in the proof's public
> signals: win probability, net odds and full-Kelly fraction satisfy f*·b = p·b + p − 1 on a 1e-9
> grid, inside a tolerance the circuit publishes as a signal of its own.
>
> **doesNotProve** — That the edge is real. The circuit takes p and b as given and says nothing about
> where they came from or whether they are estimated well — over-estimating an edge is the single most
> common way Kelly sizing ruins an account, and no proof of the arithmetic can detect it. It also does
> NOT cover `recommendedBetFraction`. Risk-of-ruin, expected log-growth and the leverage warning are
> outside it entirely.

That last sentence is the one that matters commercially and it is the one a proof makes it tempting to
soften. A verifying SNARK beside a sizing recommendation invites a reader to believe the recommendation
was verified. It was not; the arithmetic behind its ceiling was.

### A second circuit needs a second key

`/proof/vk` is a published URL. The paper quotes it and every liquidation proof carries it as a
string, so it keeps meaning the liquidation key it has always meant, and `/proof/vk/kelly` joins it.
Each proof record names its own circuit and carries the URL of the key that checks it.

This is not tidiness. A verifier handed the liquidation key for a Kelly proof gets a failed
verification with no reason attached, which reads exactly like a forged proof — the worst possible
false alarm for a product whose claim is that you need not trust it. The same applies to the on-chain
instruction: the liquidation circuit publishes eight public signals and the Kelly circuit five, so
`uint256[8]` handed to a Kelly caller is a call signature that cannot compile.

An unknown circuit refuses and names the ones that exist. A caller holding a proof they cannot check
has no way to discover the right URL from the wrong one.

---

## 5. Proving the negative, executably

Gate K was written after the guard it guards, so of course it passes. That says nothing about whether
it would catch what it was written for. `gates/gateK-revert.mjs` puts six defects back, one at a time,
and requires the gate to go RED for each and GREEN once every revert is undone — red in both states
would mean broken rather than strict.

Four of the six are genuine witness/engine mismatches, each a shape this repository has shipped
somewhere. Two attack the measurement rather than the arithmetic.

### The revert, run

```
GATE K REVERT: proving the Kelly guard can still say no

  engine build id before : q1-e1fa99d08887d6cc

  --- revert 1 (snark.js): the encoder drifts one grid step on the odds — a bet 1e-9 from the one that was sized
      gate against reverted code : 5 pass, 2 fail
      red: K.3 the bound holds on a sweep run against the real engine, and is still tight
      red: K.4 a proof built through the SERVICE verifies, and its signals are the encoded bet

  --- revert 2 (scale.cjs): the engine expression is rearranged into a mathematically equal, numerically different form
      gate against reverted code : 6 pass, 1 fail
      red: K.1 the fraction the guard compares against is the engine's expression, term for term

  --- revert 3 (scale.cjs): the canonical solve truncates instead of rounding — off by a whole step, not half of one
      gate against reverted code : 6 pass, 1 fail
      red: K.3 the bound holds on a sweep run against the real engine, and is still tight

  --- revert 4 (snark.js): the witness reads the DISPLAYED fraction instead of the integer solve
      gate against reverted code : 6 pass, 1 fail
      red: K.3 the bound holds on a sweep run against the real engine, and is still tight

  --- revert 5 (snark.js): the bound is widened to the width the answer is merely displayed at
      gate against reverted code : 4 pass, 3 fail
      red: K.3 the bound holds on a sweep run against the real engine, and is still tight
      red: K.4 a proof built through the SERVICE verifies, and its signals are the encoded bet
      red: K.5 every perturbed public signal is rejected, and so is a bent proof

  --- revert 6 (snark.js): the display rounding drifts from the engine's
      gate against reverted code : 5 pass, 2 fail
      red: K.2 the display rounding the guard asks about is the engine's own
      red: K.3 the bound holds on a sweep run against the real engine, and is still tight

  2 files restored
  gate against restored code : 7 pass, 0 fail
  engine build id after  : q1-e1fa99d08887d6cc

  [PASS] revert 1 makes gate K fail
  [PASS] and the failure is K.3, the assertion that the witness agrees with the engine
  [PASS] revert 2 makes gate K fail
  [PASS] and the failure is K.1, which compiles the engine's own line and requires Object.is agreement
  [PASS] revert 3 makes gate K fail
  [PASS] and the failure is K.3, where 2|R| <= b̂ stops holding, and K.4, where the exact case stops being exact
  [PASS] revert 4 makes gate K fail
  [PASS] and the failure is K.3, where the certified fraction leaves the bound the encoding admits
  [PASS] revert 5 makes gate K fail
  [PASS] and the failure is K.3, which requires the worst honest bet to use a real part of the bound
  [PASS] revert 6 makes gate K fail
  [PASS] and the failure is K.2, the drift check, and K.3, which stops reproducing the served answer
  [PASS] and the gate PASSES again once every revert is undone (7 pass, 0 fail)
  [PASS] engine build id unmoved (q1-e1fa99d08887d6cc -> q1-e1fa99d08887d6cc)

==========================================================================
GATE K REVERT: PASSED, the Kelly guard is capable of saying no
```

**Revert 4 is the one worth reading twice.** It makes the witness certify `round(f*, 6)` — the number
the service itself publishes — instead of the integer solve. Using the service's own published figure
feels more honest than recomputing it, which is exactly why it is the mistake a careful person makes.
It is the same mistake the liquidation witness makes if it reads the echoed `round(M, 2)` margin, and
in both cases the resulting proof verifies perfectly against a bet nobody was quoted.

**Revert 2 is the defect class this repository has shipped three times.** `(pw*b + pw - 1)/b` is the
same identity as `(pw*(b+1) - 1)/b` and a different double. K.1 catches it because it does not read the
two expressions and agree they look alike — it lifts the engine's own source line out of
`src/engine/sizeGate.js`, compiles it, and requires `Object.is` agreement over 200,000 bets weighted
onto the break-even boundary where the numerator cancels and two orderings are most likely to part.

The revert count above was taken with the gate at seven tests; K.8 was added afterwards and the gate
now runs eight.

### And the same for the Herfindahl guard

```
GATE H REVERT: proving the Herfindahl guard can still say no

  engine build id before : q1-e1fa99d08887d6cc

  --- revert 1 (snark.js): the encoder forms one share per POSITION instead of per asset — a different book, proven perfectly
      gate against reverted code : 4 pass, 3 fail
      red: H.3 the bound holds on a sweep run against the real engine, and the grouping is the engine's
      red: H.4 a proof built through the SERVICE verifies, and its signals are the engine's shares
      red: H.5 every perturbed public signal is rejected, and so is a bent proof

  --- revert 2 (scale.cjs): the sum-of-squares fold is re-associated
      gate against reverted code : 6 pass, 1 fail
      red: H.1 the index the guard compares against is the engine's expression, both folds

  --- revert 3 (scale.cjs): the canonical index truncates instead of rounding — off by a whole step, not half of one
      gate against reverted code : 6 pass, 1 fail
      red: H.3 the bound holds on a sweep run against the real engine, and the grouping is the engine's

  --- revert 4 (snark.js): the bound is widened to the width the answer is merely displayed at
      gate against reverted code : 4 pass, 3 fail
      red: H.3 the bound holds on a sweep run against the real engine, and the grouping is the engine's
      red: H.4 a proof built through the SERVICE verifies, and its signals are the engine's shares
      red: H.5 every perturbed public signal is rejected, and so is a bent proof

  --- revert 5 (snark.js): the display rounding drifts from the engine's
      gate against reverted code : 3 pass, 4 fail
      red: H.2 the display rounding the guard asks about is the engine's own
      red: H.3 the bound holds on a sweep run against the real engine, and the grouping is the engine's
      red: H.4 a proof built through the SERVICE verifies, and its signals are the engine's shares
      red: H.5 every perturbed public signal is rejected, and so is a bent proof

  2 files restored
  gate against restored code : 7 pass, 0 fail
  engine build id after  : q1-e1fa99d08887d6cc

  [PASS] revert 1 makes gate H fail
  [PASS] and the failure is H.3, whose sweep repeats assets on purpose, and H.4, whose worked book has two USDC rows
  [PASS] revert 2 makes gate H fail
  [PASS] and the failure is H.1, which compiles the engine's own hhi and requires Object.is agreement
  [PASS] revert 3 makes gate H fail
  [PASS] and the failure is H.3, where the bound is exceeded and 2|R| <= S stops holding, and H.4, where the exact book stops being exact
  [PASS] revert 4 makes gate H fail
  [PASS] and the failure is H.3, which requires the worst honest book to use a real part of the bound
  [PASS] revert 5 makes gate H fail
  [PASS] and the failure is H.2, the drift check, and H.3, which stops reproducing the served answer
  [PASS] and the gate PASSES again once every revert is undone (7 pass, 0 fail)
  [PASS] engine build id unmoved (q1-e1fa99d08887d6cc -> q1-e1fa99d08887d6cc)

==========================================================================
GATE H REVERT: PASSED, the Herfindahl guard is capable of saying no
```

**Revert 1 is the one this circuit invites and no other one here does.** It changes a single accumulator
key so that shares are formed per position rather than per asset. Everything downstream is impeccable:
the witness is well-formed, the proof verifies, every public signal is consistent with every other. It
simply describes a different book. The only thing that catches it is a sweep whose books repeat assets
on purpose — which is exactly the property the existing sweep under `zk/` does not have.

---

## 6. Nothing that already worked moved

Measured, not reasoned about.

| | measured |
|---|---|
| `size-gate#0` content hash, HTTP | `e7442ce6867cec43…` unmoved |
| `size-gate#1` content hash, HTTP | `ba489cc51f9f918f…` unmoved |
| `treasury-risk#0` content hash, HTTP | `3d40bbc180e0d33f…` unmoved |
| the same three over MCP | unmoved |
| the same six again with `{"snark": true}` | unmoved |
| Appendix C, `perp-gate` | `8575ce5ae5bfae9c…` unmoved |
| liquidation proof-retrieval key list | 11 keys, unchanged and in order |
| `/proof/vk` | still the liquidation key, `nPublic` 8 |
| engine build hash | `q1-e1fa99d08887d6cc` |
| `npm test` | 386 |
| gates `l`, `v`, `w`, `x`, `y` | green — 8, 9, 8, 8, 8 tests, 0 failures |
| `npm run docs:check` | 215 documents consistent |
| `node gates/preflight.mjs` | green |

Asking for a proof does not move a hash, and that is a property rather than a coincidence: `snark` is
destructured out of the request before anything is computed or hashed, so the same bet cannot hash
differently depending on whether a proof was requested. The `snark` sibling is attached after the
envelope is sealed, and `src/util/recipe.js` names it in `proof.excludedFromContentHash` by deriving
the list from insertion order rather than from a list anybody maintains. Gate K executes that claim
rather than restating it: the response carrying the sibling must reproduce its own published hash from
its own published recipe.

**One caller does see a change, and it is worth naming.** Someone already sending `{"snark": true}` to
`size-gate` — and receiving nothing for it, because the flag did nothing — had that flag folded into
their content hash. It is now stripped before hashing, so their hash moves once, to the hash the
identical body without the flag has always returned. Every request that does not carry the flag is
byte-identical.

Callers passing more than nine decimal places in `winProb` or `winLossRatio` also see their hash move
once, onto the grid the proof they can now ask for is stated over. Every value in this repository's
fixtures is already on that grid, so snapping is the identity on all of them.

---

## 7. What this does not fix

**The input problem is untouched, and it is the whole of what remains.** The circuit takes `p` and `b`
as given. A caller who estimates their edge optimistically gets a verifying proof of a ruinous bet,
and nothing in a SNARK can say otherwise. This is the same residue `PERP_SNARK_REACHABLE.md` records
for the entry price, and `QUIVER_ROADMAP_V2.md` is right that it is where the road honestly ends.

**Nothing is deployed.** `zk/build/KellyVerifier.sol` exists, is gated against a local EVM by
`zk/scripts/gateB2-kelly-evm.mjs`, and has no address on any chain. The `onChain` block on a Kelly
proof describes what would check it, not something that has happened.

**Nothing else is deployed either.** `zk/build/ConcentrationVerifier.sol` is in the same position as
the Kelly one: written, gated against a local EVM, no address anywhere.

**Four of the six named engines are still on the far side of the fence.** Their circuits exist and
their gates pass; no caller can reach them. §8 says what each would take, and which one of the four is
a wall rather than a to-do.

**The proof covers full Kelly, not the recommendation, and not risk-of-ruin.** Said again here because
it is the claim most likely to be softened in a summary.

**Proving is not free and the free surface can ask for it.** A Kelly proof is roughly 405 ms of one
core. Proofs are built one at a time behind a queue bounded at eight, and callers past the backlog are
told no rather than silently stacking work — but two reachable circuits now share that one queue, so a
burst of `size-gate` proof requests can delay a `perp-gate` proof. Neither response path waits on it.

---

## 8. The other four, measured rather than guessed

Every one of these has a circuit and a passing gate under `zk/`. None was wired. What follows is the
specific obstacle in each case, and whether it is structural or merely unfinished — surveyed against
the engines and the circuits rather than reasoned about from the roadmap.

| | obstacle | verdict |
|---|---|---|
| `exec-verify` → `constantproduct` | the effective input `dx·(1−f)` is never published, so the witness must recompute it; reserves routinely exceed 9e6, where the scaled-product encoding is wrong by up to 64 grid steps | unfinished |
| `lp-risk` → `divergence` | a square root arrives as a witness and is forced by `ŝ² = r̂·S`, so the encoder must supply an integer root rounded rather than floored; and two of the three published blocks have no closed form at all | unfinished, with a large carve-out |
| `options-risk` → `greeksfp` / `parity` | per-value mantissa-and-exponent encoding rather than a shared grid | unfinished; the roadmap is out of date about why |
| `portfolio-gate` → `portfoliogate` | the circuit is compiled for THREE legs and sits 126 Plonk gates below the domain ceiling | the one genuine structural wall |

### `exec-verify` — unfinished, and the trap is named

The benchmark is a closed-form algebraic function of the four inputs the circuit takes, with no
expectation and no iteration. Three things stand between it and a wiring, all ordinary:

The engine computes `(y * inEff) / (x + inEff)`, one multiply then one divide. The circuit's header
documents the same benchmark as `y − x·y/(x + inEff)`, which is the same identity and a different
double — measured at a flat five grid steps, about three and a half times the honest allowance. The
expression to lift is the engine's, as always.

`inEff` is a local. It is never published, so a witness must recompute `dx·(1−f)` from the echoed
inputs, and `honestOut` is published at `round(honestOut, 8)`, so the display half-unit is 5e-9.

And the encoding trap is real here in a way it is not for a probability: **AMM reserves routinely
exceed 9e6**, which is exactly where `Math.round(x * 1e9)` exceeds 2^53 and lands on the wrong integer
— up to sixty-four grid steps wrong, which is how 455 of 3,595 pools were once refused. `scale.cjs`'s
`toScaled` goes through `toFixed(9)` and is safe, and any new encoder must go through it rather than
around it.

The scope carve-out is the same shape as Kelly's: the service's headline is `adverseExecutionBps`,
computed against `amountOutRealized`, and the circuit has **no signal for the realized amount at all**.
A proof would cover the BENCHMARK the verdict is measured against, not the verdict. Reference mode —
which returns no `honestOut` — would need refusing by name.

### `lp-risk` — unfinished, but only one of three published blocks is provable at all

`realizedIL.impermanentLossPct` is the closed form and is provable. The encoder needs a BigInt integer
square root, rounded rather than floored, because `Math.sqrt(r) * 1e9` is a double rounding that puts
the residual where the arithmetic is instead of where the identity is. The guard would bound two
residuals rather than one — the identity and the root — and the circuit refuses `r = 0`, refuses
`L > 1`, and caps the ratio at about 17,592×. A book at `concentrationFactor > 1` publishes a
LINEARISATION, `ilFull × conc`, which has no term in the circuit and would need refusing by name.

**The carve-out is much larger than the proven part, and it is where the service's actual verdict
lives.** `expectedDivergence.expectedIlPct` is a 401-point numerical quadrature over a lognormal, and
`feeVsDivergence.breakevenVolatility` is a 200-iteration bisection over that same quadrature — roughly
80,000 transcendental evaluations, with an unbounded doubling loop in front of it. No identity restates
either. The circuit's own header already says so, and any `doesNotProve` text would have to carry it
prominently rather than in a clause.

### `options-risk` — the roadmap is out of date about why this is hard

The roadmap calls it a research project because Black-76 greeks need `exp` and `erf` in-circuit. The
circuits that exist **do not compute either**. `greeksfp.circom` proves that the published greeks are
mutually CONSISTENT with Black-76 for the given forward, vol and time — vega·100 = gamma·F²·σ·T — and
`parity.circom` proves put-call parity. Neither evaluates the normal CDF.

So the transcendental is dodged, not solved, and what remains is ordinary work: a per-value
mantissa-and-exponent encoding, `x = m · 10^−e` with `m` forced into [1e8, 1e9), because on the shared
1e-9 grid a deep out-of-the-money gamma of 5e-10 is ONE step and the residual is 1/gamma. That encoding
was measured at 7.344e-9 worst relative residual against 6.077e-1 on the shared grid, with no surface
dropped — and the resulting circuit is *cheaper* than the fixed-grid one it replaces, because the
identity ties the exponents together and the alignment selector needs a few dozen entries rather than
hundreds.

What is provable is real and narrower than a reader would assume: **a service with a subtly wrong
normal CDF satisfies every one of these identities and is still wrong about the absolute price level.**
Parity reaches the price and constrains only the DIFFERENCE `C − P`, so both prices could be wrong by
the same amount and still pass. That residue is permanent until `erf` is provable, and it would have to
be the first sentence of the `doesNotProve` rather than a footnote.

### `portfolio-gate` — the one genuine wall, and precisely which wall

`portfoliogate.circom` fixes N at three in its `main` component. That is not a parameter anything at
runtime can vary, and it is not one gate away from being four: the circuit compiles to 3,970 Plonk
constraints against a domain of 4,096, **126 gates of slack**. A fourth leg is roughly another 1,300,
which needs the next power-of-two domain and therefore a larger powers-of-tau than the `hez_final_12`
this project uses. Full-parity bit widths at N=3 already blew the ceiling by 444 gates once, and the
fix was narrowing the input domains — which is where a fifth of the refusals now come from.

**Padding does not rescue it the way it rescues `concentration`.** A short book pads by REPEATING one
of its own legs, which is sound because a duplicate cannot change an argmin and the duplicated leg's
identity is one already proven. Zero-padding is structurally forbidden: three separate constraints
reject a zero leg, and all three are load-bearing. And a fourth leg is real rather than absent, so
there is nothing to repeat.

Two further facts make this worse than a domain restriction:

The service imposes **no matching limit**. `positions` has no `maxItems`, and account mode pulls
whatever the address holds. So the wall is not visible to a caller until they hit it.

And within the domain the refusal rate is already **54.6%** across 1,500 books — of which 21% is
`qHat` exceeding its narrowed bound, 22% is a leg already past liquidation, and 9.5% is the engine
naming no unambiguous nearest leg. That figure **excludes** the leg-count wall entirely, because the
sweep that produced it never generates a book with more than three legs.

There is a further defect waiting there, already measured and not mine to fix here: `portfolio-gate`
does not grid-snap, so a proof today would certify liquidation prices up to 6.0e-3 from the ones served
and distances up to 1.0e-2 percentage points off — twenty times the third decimal the ranking is
published at.

**Wiring it honestly needs one of three decisions first**: refuse four legs or more by name on the
request path, compile a family of circuits by leg count as `kellybatch1..4` already does, or move to a
larger ceremony. All three are real options. None is a line of code, and choosing between them on the
way past would have been the rushed version of this work.

---

## 9. How to run it

```
npm run gate:k              # 8 tests, fully offline, ~3s plus one real proof
npm run gate:k-revert       # 6 scripted defects; each must turn gate K red
npm run gate:h              # 7 tests, fully offline, ~2s plus one real proof
npm run gate:h-revert       # 5 scripted defects; each must turn gate H red
npm test                    # 386
node gates/preflight.mjs    # the proof-emitting set, the grid, and the artifacts
npm run docs:check          # 215 documents against the running system
```

Gates K and H are deliberately offline. Gate W, their liquidation counterpart, reads the live
Hyperliquid universe because the liquidation guard's worst cases are real perps. The Kelly guard's
worst cases are a probability and a ratio, and the Herfindahl guard's are eight shares of a book;
neither needs a venue to generate, and a synthetic sweep reaches both far more thoroughly than any
live book would.

Each gate goes through its service's own `run` and through `handleRpc` rather than building its own
witness.
That is the entire point of it, and the reason the six circuit gates under `zk/` prove less than they
appear to.
