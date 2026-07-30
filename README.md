# Quiver

**The verifiable risk brain for autonomous agents.** Twenty-two priced quantitative computations an
agent calls over HTTP, pays for in-band with [x402](https://github.com/coinbase/x402), and discovers
through the [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) trustless-agent registry. No chat, no
human in the loop. Every deterministic answer arrives with a proof you can re-derive yourself.

- **Live endpoint:** https://quiver-production-c3a8.up.railway.app — [`/build`](https://quiver-production-c3a8.up.railway.app/build) and [`/paper`](https://quiver-production-c3a8.up.railway.app/paper) are free; the paper is also served as plain markdown in seven AI-readable parts at `/paper/1` … `/paper/7`
- **Free MCP:** `https://quiver-production-c3a8.up.railway.app/mcp` — Streamable HTTP, the nine risk-brain tools, fair-use daily quota; on the [official MCP registry](https://registry.modelcontextprotocol.io) as `quiver-risk-brain`
- **On-chain identity:** ERC-8004 agent `#5152` on X Layer (`eip155:196`) · **Build:** `q1-e1fa99d08887d6cc`
- **Payment (dual rail):** x402 v2 `exact` — USD₮0 on X Layer (OKX facilitator) **and** USDC on Base (Coinbase CDP facilitator); 0.005–0.05 per call
- **Availability, measured from outside:** [status page](https://cgn9npwmm0.execute-api.us-east-1.amazonaws.com/) ([JSON](https://cgn9npwmm0.execute-api.us-east-1.amazonaws.com/?format=json)) — hosted deliberately off the service it watches, so the record survives an outage
- **Use it in five minutes:** [QUICKSTART.md](QUICKSTART.md) · framework snippets: [INTEGRATIONS.md](INTEGRATIONS.md)
- **Launch thread, with the demo video:** [x.com/Quiverrrs/status/2080225222880526720](https://x.com/Quiverrrs/status/2080225222880526720)

---

## At a glance

| | |
|---|---|
| **What it is** | An Agentic Service Provider: twenty-two priced computations an autonomous agent calls over HTTP, at 0.005–0.05 USD each — cheap enough to poll inside a decision loop. |
| **The one idea** | An agent should not have to trust a number it just bought. Deterministic answers ship a **proof envelope** — echoed inputs, code identity, a content hash, and a self-check against the condition the answer was solved from — so the caller re-derives the result instead of believing it. |
| **What it computes** | Perpetual liquidation and funding, cross-venue portfolio stress, Kelly sizing and risk of ruin, arbitrage-free options analytics and greeks, execution-quality checks, LP and treasury risk, event volatility, transaction and EIP-712 signature safety, DEX microstructure, prediction-market fills, protocol health, and on-chain attestation of a day's answers. |
| **Live-market answers** | Cannot promise a re-run, and say so. They ship a signed, timestamped **observation envelope** instead, and the distinction is enforced in code rather than left to the reader. |
| **Checkable in thirty seconds** | The agent listing on X Layer, one settlement on each payment rail, an EAS schema on Base, the build hash at `/build`, and a worked proof whose content hash and signature you can reproduce — none of it needing our cooperation. → [checkable artifacts](docs/checkable-artifacts.md) |
| **Strongest evidence** | A population-scale replay of the October 2025 crash and two out-of-sample 2026 crashes: flagged accounts were liquidated at 14.3× and 13.3× the rate of cleared ones — on a flag that fires on 41.6% and 43.8% of accounts, which belongs beside the ratio and not after it. → [verification](docs/verification.md) |
| **Strongest counter-evidence, ours** | Our own ablation reduces that result to raw distance-to-liquidation — and that distance is the *venue's* published number, not one this engine computed, so the study validates the quantity rather than our arithmetic on it. The flag also fires on 42–44% of accounts. Both sit beside the headline, not in a footnote. |
| **Traction, honestly** | Small, and measured on chain rather than from our own counter. Six payer addresses that are not ours sent **44 payments totalling 0.575 USD₮0** over the eight days to 27 July 2026; **four of the six paid more than once**, one returning across 2.55 days. Half a dollar is not a business. An earlier version said three wallets and zero recurrence — that came from an in-memory instrument that resets on every deploy. → [verification](docs/verification.md) |
| **Verified on chain** | Add `"snark": true` to a perp-gate call and a **PLONK proof** of the liquidation identity is built off the request path; [`QuiverProofRegistry`](https://www.okx.com/web3/explorer/xlayer/address/0xd50A91E36673443749Ee22031cb2Ff09d4Bb8D60) on X Layer checks the arithmetic itself and records the outcome. Live since 28 July 2026: one transaction [accepting a proof bought from the live endpoint](https://www.okx.com/web3/explorer/xlayer/tx/0x50397d713b96414800fef2dc6c2b4b8a48bd89d7f793683df9deddfbe73f368a) and one [rejecting a tampered copy](https://www.okx.com/web3/explorer/xlayer/tx/0x97502c78e61958a9a1013a257bf281c665684e214d6474c41444eb0294cb4aac). The chain holds `58329.113924051` against the `58329.11` that was sold. **Nothing about our identity, uptime or reputation is load-bearing in that sentence** — a seller who lies produces a proof that fails in public. → [on-chain verification](docs/onchain-verification.md) |
| **It buys, not just sells** | The other half of an agent economy, and the half almost nobody shows. On 28 July 2026 Quiver paid **agent #4462 (MacroLens)** 0.01 USD₮0 over x402 on X Layer and received the deliverable: settlement [`0x51f44374…a1539`](https://www.okx.com/web3/explorer/xlayer/tx/0x51f443741a2402e337f7f987d0fcd8b05e8b64f0738ecf7a0ab000347caa1539), HTTP 200 in 0.81 s. Bought as evidence, not as an ingredient — no engine consumes it, and the survey behind that decision is in the doc. → [on-chain verification](docs/onchain-verification.md) |
| **Tests** | **386** model-free tests, 381 passing, 5 skipped for want of an archive node, 0 failing. Many provably fail on the pre-fix code — verified by reverting each fix and watching them go red. |
| **What it refuses to do** | Output a directional edge. Infer dealer positioning it cannot measure. Call a variance premium significant when it is not. Guess when the data is missing — it answers `DATA_UNAVAILABLE`, for free. |

---

## Since the deadline

The submission closed on 28 July 2026 and judging runs after it. OKX confirmed that during judging
they cannot go back and forth resolving errors: if the service breaks while being scored it simply
comes back empty. Our own redeploys were expected to take up to three minutes before the new
container serves, so the original plan was to build everything without deploying at all.

**That plan changed, and this paragraph used to claim otherwise.** It said the live endpoint had not
been touched since the deadline. That was true when it was written and false by the time anyone read
it: **three deploys have shipped** — 28 July at 17:20:59 UTC, and 29 July at 00:30:41 and roughly
09:30 UTC. They went out because leaving them undone was the larger risk: they carried a mis-route
signpost that had been telling callers with *correct* requests they had asked the wrong service, a fix
for inputs like `side: "SHORT"` being silently answered as a long, signed and billed, and the corrected
paper.

The three-minute estimate did not survive contact either. **Measured darkness was 11 seconds on the
first deploy and 0 seconds on the second** — the service answered every poll straight through the
container swap. **The third was never timed.** All were run behind a watchdog that establishes a marker
only the new build can produce, polls until it appears, and records any window where the service
stopped answering; `gates/` holds it, along with a preflight that refuses to pass unless the codeHash,
the service list, the endpoint and the advertised schemas are all unmoved.

**This paragraph counted two deploys until 29 July, and gave the wrong darkness figure for both.** It
listed only the two on 29 July and then reused the phrase "11 seconds on the first and 0 on the second"
from a log where "first" and "second" meant different deploys — putting 11 seconds on one that had none
and 0 on one nobody timed. The watchdog prints darkness and writes no file, so the two real figures
survive only in commit messages written minutes after the fact; the third deploy's is simply unknown
and is not guessed at here. `docs/deploy-manifest.md` carries the evidence table.

The machine-readable paper stays at exactly seven parts, because the submitted entry hardcodes seven
URLs. That has held through every change, and `npm run gate:y` now checks the section-to-part mapping
rather than the part count, because a section can move between parts while the count stays at seven.

### A second circuit: the Kelly sizing identity

The honest cap on this project is that the on-chain proof layer covers **one computation of
twenty-two**. `size-gate` is the second, chosen because it is the smallest: the discrete Kelly
criterion `f* = (p(b+1) − 1)/b` cross-multiplies to a single polynomial identity, where the
liquidation identity needed a division cleared through three factors of SCALE.

| | |
|---|---|
| Circuit | [`zk/circuits/kelly.circom`](zk/circuits/kelly.circom) — **372 R1CS / 718 Plonk constraints**, zero private inputs (the first circuit, liquidation, is the older [`research/zk/circuits/liquidation.circom`](research/zk/circuits/liquidation.circom), where its build notes live) |
| Statement | `f̂·b̂ = p̂·b̂ + S·p̂ − S²`, with the residual bounded by `2·|R| ≤ b̂`, derived from a public signal so a prover cannot widen it |
| Proving | **547 ms**, zkey 2.2 MB (the liquidation circuit: 703 ms, 5.3 MB) |
| Verifier | [`zk/build/KellyVerifier.sol`](zk/build/KellyVerifier.sol), 6,552 bytes deployed |
| On chain cost | **273,118 gas** to accept · **573 gas** to reject a bent proof |

Three gates, each able to fail:

```bash
node zk/scripts/gateB0-kelly.mjs        # proves, verifies, and refuses all 5 perturbed signals
node zk/scripts/gateB1-kelly-sweep.mjs  # 4,000 bets through the real engine; bound never violated
cd zk && npm install                    # solc + an in-process EVM, gate-only, never shipped
node scripts/gateB2-kelly-evm.mjs       # Solidity verifier in an EVM: accepts, then refuses 6 ways
```

The first two run against a fresh clone with no extra install. The third needs `zk/package.json`'s
dependencies, which are deliberately **not** in the service manifest: `solc` and an in-process EVM
rehearse a verifier, they never answer a request, and the thing that serves traffic should not carry
them.

**That paragraph is a correction.** An earlier version of this section said all three were "runnable
from a clone", and none of them was. Every script under `zk/scripts` imported the engine as
`../../hackathon/veritape/src/...`, which is a path in the author's working tree and does not exist in
this repository, so all five gates — including `gate2` and `gate3`, cited elsewhere as re-runnable
rehearsals of the on-chain registry — died with `ERR_MODULE_NOT_FOUND` for anyone who cloned it. The
proving key and witness wasm were missing too: the repo shipped the verification key and the gate
*results*, but not the artifacts needed to reproduce those results. Verifiability from a clone is the
load-bearing claim of this whole project, and it was untested, so it drifted.

```bash
node zk/scripts/gate-clone-portability.mjs   # the check that was missing
```

It refuses two failure modes specifically: a local module that cannot be resolved, and a build
artifact that is not in the checkout. It does not demand that every gate *pass*, because `gate3` talks
to a live chain and a network failure is not a portability failure. Proven able to fail by pointing
one gate back at the old path: it goes red on three counts and names the offending file.

**Gate B1 failed the first time it ran, and that is the point of it.** 3,997 of 4,000 sampled bets
blew the residual bound by a factor of about a thousand. The cause was not the circuit: `sizeGate`
publishes `fullKellyFraction: round(fullKelly, 6)`, so certifying the served number would have proved
an identity about a bet up to 5×10⁻⁷ away from the one actually sized — five hundred grid steps, and
exactly the factor of a thousand observed. This is the same defect class the liquidation circuit hit
when the engine handed back `round(M, 2)` for margin. The witness now recomputes the fraction at full
precision from the snapped inputs, with a guard that refuses to certify at all when the result drifts
past the six decimals the answer is published at. After the fix: **0 violations in 4,000, tightest
case using 0.9997 of the bound** — tight rather than generous, which is what makes it worth proving.

Those two constraint counts are now **read from the artifacts** by
[`zk/scripts/circuit-facts.mjs`](zk/scripts/circuit-facts.mjs) rather than written down. They used to
be literals: the gate recorded `plonkConstraints: 718` by hand, and this table said "357 R1CS", which
is circom's *non-linear* count and not what the `.r1cs` file holds. The literal was right and the
label was wrong, and neither was ever compared to the file it described, which is the only part that
mattered.

**Not yet shipped, stated plainly:** the live `size-gate` service does not serve these proofs and no
Kelly verifier is deployed on chain. Both need either a deploy or gas, and neither is worth the risk
while reviewers are testing. This is exactly what the paper said about the liquidation circuit before
it shipped: built, and verifiable from a clone.

### Answering the wrong question correctly

Agent #5152 holds twelve on-chain reviews: ten at five stars and two at half a star. Both bad ones are
from the same reviewer agent, and its own comments say what happened.

> "Wrong endpoint: options-desk can't do Aave health checks. No deliverable."
> "Delivered crypto options/vol data, not the Aave health check that was requested"

It wanted a lending-protocol health check and called `options-desk`. Two other agents ran the same
Aave task through `protocol-pulse` and scored it **5.0 and 4.8**, so the capability was there and
working. The reviewer picked the wrong service out of twenty-two, and Quiver had no way to say so.
Read it yourself: `onchainos agent feedback-list --agent-id 5152`.

It failed twice, in two different ways:

| | what happened | what could have helped |
|---|---|---|
| call 1 | body did not fit `options-desk`, so it was refused | the refusal said what `options-desk` needs. True, and useless: it never named the service that does Aave |
| call 2 | body **did** fit, so it succeeded and returned a correct options surface | nothing. No refusal happened, so no refusal message could help |

The second is the dangerous one. **A service that answers the wrong question correctly looks, from
outside, exactly like a service that is wrong.**

[`src/util/routing.js`](src/util/routing.js) closes both. It scores the request against all
twenty-two services on two signals kept deliberately apart: *shape*, meaning which required keys the
body carries, which is a fact about the service; and *words*, meaning vocabulary overlap, which is a
guess and is weighted as one. A refusal now names the service that fits and gives the exact call to
retry. A success that looks mis-aimed carries a `routingNotice` beside `result` and `proof` — never
inside either, so the content hash is untouched and every published proof still reproduces.

The case that took a second attempt to catch is call 2: the body satisfied `options-desk` completely
*and* carried `protocol`, a key `options-desk` has never heard of and `protocol-pulse` requires. A
foreign required key in an otherwise valid body is the signature of a mis-route, and the first version
of the detector missed it entirely.

```bash
npm run gate:r   # replays both of MantaRay's calls and requires the signpost
```

Six checks. Two replay the reviews. The other four are the half that can fail: an ordinary options
request must **not** be flagged, all twenty-two services must leave their own minimal valid requests
alone, an empty body belongs to the validator rather than the signpost, and hard evidence must outrank
weak evidence. Proven able to fail by a scripted revert: with the detector stubbed out, 2 of 6 go red.

**Quiver never reroutes a paid call.** You asked this endpoint and this endpoint answered. The
signpost exists so a caller can tell a wrong shop from a wrong answer, which is precisely the
distinction the two half-stars failed to make.

### Portfolio proofs: the wide circuit was the wrong question

`portfolio-gate` reports the leg nearest liquidation, a minimum over legs. Proving a minimum inside
one circuit forces every leg into one evaluation domain, and a leg **is** the liquidation circuit at
1,301 constraints, so the ceremony file on hand caps it at three. The obvious answer was to fetch a
bigger file. Both halves of that turned out to be wrong.

The file is not big: 2^14 is **18.1 MB**, not the "gigabytes" an earlier draft of the plan claimed.
But `zk/scripts/domain-scaling.mjs` measures proving at domain^1.01, so twelve legs would take about
5.7 s and break the roadmap's own three-second abandon threshold. A bigger file moves the wall.

So `zk/scripts/gateB6-portfolio-routes.mjs` measured the alternative: prove each leg separately and
let a contract take the minimum on chain. A Plonk proof is constant size and constant verification
cost whatever the circuit behind it, which is the fact the whole comparison turns on.

| | one wide circuit | one proof per leg |
|---|---|---|
| gas (11 legs) | 292,124 <!--gas:gateB8-2-portfolio-evm#acceptGas~2%--> | **2,948,931** <!--gas:gateB6-portfolio-routes#routeB.gas~2%--> (10.1×) |
| cost on X Layer at 0.02 gwei | 0.0000058 OKB | **0.000059 OKB** |
| proving | ~5.4 s, serial, unsplittable — EXTRAPOLATED | 858 ms/leg, **~1,166 ms if parallel** |
| buildable today | **no** — needs 2^14 | **yes** — with what is already on disk |

Both gas figures are single samples: `zk/scripts/probe-plonk-gas-variance.mjs` measures a 1.26% spread
across identical statements, and the 11-leg row moves by about 9,000 gas between runs. The wide figure
is read from `zk/build/gateB8-2-portfolio-evm.json` rather than written down; an earlier draft of this
table said ~273,118, which matched no artifact in the repository.

The 10.1× gas that looked like the deciding trade is worth about five hundredths of a millicent on this
chain. One invalid leg reverts the whole call, because a minimum over whatever happened to verify is not
a minimum.

**And the minimum that call takes is over the liquidation PRICE, not over the distance to it.** This
table used to end "the contract picks the right leg", which was wrong and the gate's own check could not
catch it — it compared the router against the router's own rule. On this eleven-leg book the price
minimum is leg 3, **24.089%** from liquidation; the leg `portfolio-gate` reports is leg 10 at **6.103%**.
`liquidation.circom` publishes no mark, so that router cannot be corrected in place. The gate now
measures the aggregation shape and asserts its own limit — `npm run gate:b6-revert` in `zk/` restores
the old claim and the gate goes red. The portfolio minimum is proved instead by
`zk/scripts/gateB10-portfolio-perleg.mjs` over `zk/circuits/portfolioleg.circom`, which publishes the
adverse-distance numerator and the mark and ranks them by cross-multiplication on chain. Full write-up:
[`docs/fix-gateb6-ranking.md`](docs/fix-gateb6-ranking.md).

Nothing is deployed; `CertifiedPriceMin.sol` exists only inside that test.

### Three more circuits: treasury, LP divergence, execution

Tier 1 of [the completion plan](docs/phase-b-remaining-plan.md). The proof layer now covers **five of
the twenty-two services** and five of the nine that have a deterministic path. Every size below is
read from the artifact by `node zk/scripts/circuit-facts.mjs`, not written down.

| service | circuit | R1CS | Plonk | prove (warm) | accept gas | reject gas |
|---|---|---|---|---|---|---|
| `perp-gate` | liquidation | 667 | 1,301 | — | 468,459 (on chain) | — |
| `size-gate` | [kelly](zk/circuits/kelly.circom) | 372 | 718 | 328 ms | 273,118 | 573 |
| `treasury-risk` | [concentration](zk/circuits/concentration.circom) | 451 | 834 | 346 ms | 277,332 | 573 |
| `lp-risk` | [divergence](zk/circuits/divergence.circom) | 463 | 887 | 345 ms | 273,088 | 573 |
| `exec-verify` | [constantproduct](zk/circuits/constantproduct.circom) | 671 | 1,293 | **697 ms** | 276,476 | 573 |

Nine gates, three per circuit, all runnable from a clone (the EVM ones after `cd zk && npm install`):

```bash
node zk/scripts/gateB3-1-concentration-sweep.mjs   # 4,000 treasury books through the real engine
node zk/scripts/gateB4-1-divergence-sweep.mjs      # 4,000 price ratios, 1/100x to 100x
node zk/scripts/gateB5-1-constantproduct-sweep.mjs # 3,595 pools across seven orders of magnitude
node zk/scripts/gate-clone-portability.mjs         # and the check that all of the above still run for you
```

**A square root is proven, not computed.** `lp-risk` rests on `IL = 2√r/(1+r) − 1`, and circuits do
not take roots. So `s` arrives as a witness, the circuit forces `s² = r·S` and pins it non-negative so
the other root cannot be substituted, and the identity then cross-multiplies to
`L̂·(S + r̂) = 2·S·ŝ` with no division left. The gate refuses a wrong root, and refuses the negative
root offered as a field element, because that second one is the whole reason the bit decomposition is
there.

**Every bound is tight, because a loose bound is not evidence.** The concentration circuit shipped
with `2|R| ≤ 4S` on a derivation that counted two rounding sources. The sweep put the worst of 4,000
real books at a quarter of it, and the derivation was simply wrong: `Σŵ²` is computed *from* the
snapped weights, so weight rounding changes which book is described rather than how well the identity
holds for it. The bound is now `S`, and the worst case uses 0.9986 of it — which upgrades the claim
from "near the right index" to "the correctly rounded Herfindahl index of the published shares".
Measured, then tightened, in that order.

**What the three sweeps caught.** All three failed at least once, which is the only reason their green
results are worth anything:

- `toScaled` in the shared kit read `BigInt(Math.round(snap(x) * 1e9))` — **the exact scaled product
  its own comment warned against**. Harmless for a probability; at an AMM reserve of 8.03e8 the double
  has a granularity of 128, so the encoder was off by up to sixty-four grid steps. Now assembled from
  the decimal string, exact at any magnitude.
- The constant-product encoder computed `y − x·y/(x+in)` where the engine computes
  `(y·in)/(x+in)`. Algebraically identical, numerically not: the first cancels two large numbers to
  leave a small one. **Third appearance of this defect class**, after a display-rounded margin and a
  display-rounded Kelly fraction, and the same fix each time — use what the engine uses, arranged how
  the engine arranges it.
- The agreement guard refused 455 of 3,595 pools at a flat, suspiciously round **5.0 grid steps** that
  did not move when the encoder changed twice. 5e-9 is exactly half of 1e-8, and `honestOut` is served
  as `round(honestOut, 8)`. A constant gap that survives two encoder fixes is not the encoder.

**Latency, against the 500 ms bar.** Three circuits prove warm in 328 to 346 ms. `constantproduct`
takes 697 ms and is **over**, because 1,293 Plonk constraints force a 2,048-point evaluation domain
where the others fit 1,024. It came down from 1,553 by dropping two comparators that were implied by
constraints already present and by narrowing the fee-residual window from 66 bits to 34. Getting under
1,024 would mean cutting another 270, and 55% of what remains is six 62-bit range decompositions that
are load-bearing for soundness; narrowing them to fit would cap reserves at about 4.5M tokens, and the
sweep already reports 405 of 4,000 pools outside the current 2^62 domain. So it stays at 697 ms and is
reported rather than hidden. **None of it is on the request path** — the live service answers in 275
to 348 ms p50, measured, because a proof is built behind the response and not inside it
(`node zk/scripts/latency.mjs --live`).

**Not shipped:** no endpoint serves any of these three, and no verifier for them is deployed. Both
need a deploy, and deploys wait while judging runs.

### The proof now outlives the process

Until this week the proof store was a `Map`. A redeploy cleared it, and a second replica would answer
404 for a proof the first replica had just built. The endpoint said so in its own 404 body, which was
honest but was not a fix — and "held in memory" is not a property anything on chain should depend on.

A proof is immutable and is already named by its own content hash, so this is a lookup change, not a
design change. [`src/util/proofStore.js`](src/util/proofStore.js) writes a finished proof under its
hash and reads it back on a memory miss. Three decisions are worth stating because they are the ones
that could have been wrong:

- **Only `ready` is persisted.** A `building` record is a fact about a process, not about arithmetic.
  Persisting it would mean a crash mid-proof leaves a permanent "building" on disk that nobody is
  working on and every later reader polls forever. `failed` and `unavailable` are excluded for the
  same reason: a refusal is a judgement made by one build of the code, and a fixed prover should not
  keep serving the old refusal.
- **Off unless configured.** Neither `QUIVER_PROOF_S3_BUCKET` nor `QUIVER_PROOF_DIR`, no behaviour
  change of any kind. `/build` reports which of the three worlds a deploy is in, and the 404 body says
  the matching thing rather than the reassuring one.
- **An object store, not a volume.** The claim is that a proof survives a redeploy *and a second
  replica*. A Railway volume cannot carry the second half — Railway's own reference says "Replicas
  cannot be used with volumes", one volume per service, region-pinned — so a volume would have
  delivered half the claim while the endpoint advertised both. The store therefore has an S3 backend
  beside the filesystem one, chosen by environment. The filesystem backend was **kept**: it is the one
  anyone can exercise from a clone with no credentials, which is what keeps the gate runnable
  unattended. Details, and what is and is not proven without real AWS keys, in
  [`docs/PHASE_A_S3.md`](docs/PHASE_A_S3.md).

```bash
npm run gate:a          # builds a proof in one process, kills it, reads it from another — both backends
npm run gate:a-revert   # removes the feature five separate ways, proves the gate goes red each time
```

`gate:a` spawns a real child process, waits for it to exit, then reads the proof from a second,
unrelated pid. It carries its own negative control: a third process with no store configured must
**not** find the same proof, otherwise the gate would be measuring the prover instead of the store.
A fourth process boots the whole service and is asked for `/proof/<hash>` over HTTP — because the
store is asynchronous, and a route that reads it without awaiting would answer 200 with an empty body
that reads exactly like a cache miss. Eleven cases, every one run against both backends.

`gate:a-revert` is the part that makes the green result mean something. It removes the feature five
ways — writes become a no-op, the durable read is deleted, durability is claimed instead of probed,
the endpoint's `await` is dropped, a failed write is swallowed — reruns the gate after each, and
requires it to go red every time and to come back to **11 of 11** once all five are undone. A gate
that is red in both states is broken, not strict, so both halves are checked.

**Where this actually stands:** the store code is deployed and switched OFF, which you can confirm
yourself — `curl .../build` reports `proofStorage: {"durable": false, "kind": "in-memory only", …}`.
Turning it on is a bucket and a role: no code change, no endpoint change, no re-review. These cases
deliberately sit in `gates/` rather than `test/`, and they are staying there: the paper is served live
and states the size of the model-free suite, so moving that number in the repo while the live paper
keeps the old one would create exactly the staleness this project keeps auditing for — and the only
thing that could reconcile them is re-cutting the paper to describe a feature that is switched off.

### Quiver bought from another agent

See the [At a Glance](#at-a-glance) row and [on-chain verification](docs/onchain-verification.md).
Settlement `0x51f44374…a1539` on X Layer, 0.01 USD₮0 to agent #4462, deliverable returned in 0.81 s.
Zero deploys: a purchase is a transaction from our wallet, not a change to the service.

---

## Documentation

The full technical documentation is one continuous document, served as
[`/paper`](https://quiver-production-c3a8.up.railway.app/paper) — typeset, with figures, mirrored at
[`assets/whitepaper.html`](assets/whitepaper.html)
([PDF](https://drive.google.com/file/d/1K44jmBBLyFed1qF6Ib62YRh8J-jMQ-xW/view?usp=sharing)).

**Reading it with an AI?** That page is 400 kB of styled HTML and will not arrive whole in one fetch.
The identical text is served as plain markdown in seven parts, each small enough to read in a single
request. **Nothing is abridged** — the parts concatenate to the whole document, cut only at section
boundaries, and [a test](test/paperMachineReadable.test.mjs) asserts exactly that.

| | |
|---|---|
| [`/paper/1`](https://quiver-production-c3a8.up.railway.app/paper/1) | Abstract · At a Glance · Contents · 1 Introduction · 2 System Architecture · 3 Design Principles |
| [`/paper/2`](https://quiver-production-c3a8.up.railway.app/paper/2) | 4 Service Catalogue |
| [`/paper/3`](https://quiver-production-c3a8.up.railway.app/paper/3) | 5 Methodology |
| [`/paper/4`](https://quiver-production-c3a8.up.railway.app/paper/4) | 6 Verification and Testing · 7 Worked Walkthrough · 8 Limitations |
| [`/paper/5`](https://quiver-production-c3a8.up.railway.app/paper/5) | 9 Related Work · 10 The Build |
| [`/paper/6`](https://quiver-production-c3a8.up.railway.app/paper/6) | 11 Roadmap · 12 Conclusion |
| [`/paper/7`](https://quiver-production-c3a8.up.railway.app/paper/7) | Appendix A API · Appendix B Reproducibility · Appendix C Checkable Artifacts · References |
| [`/paper/full`](https://quiver-production-c3a8.up.railway.app/paper/full) | the whole document in one response (237 kB — may truncate in your client) |

The split was measured, not guessed. Stripping the markup gave 237 kB of clean markdown, and a real
fetch of *that* still stopped at about 40%, mid-sentence in §5.19, reporting the References and all
three appendices as missing. The budget belongs to the reader, so the document had to arrive in
pieces. Generated by [`tools/paper-to-text.mjs`](tools/paper-to-text.mjs).

The same material is also split by topic below. Each file is short enough to read in one pass and
points at the artifact that settles its claims.

| Document | What is in it |
|---|---|
| [**Verifiability**](docs/verifiability.md) | The proof envelope and the observation envelope, what each establishes, what a self-check does and does *not* catch, and the three tiers of trust the live-data path actually has. **Start here** — it is the reason the rest exists. |
| [**Services**](docs/services.md) | All twenty-two computations: what each returns, from which source, at what price, and which are deterministic. |
| [**Mathematics**](docs/mathematics.md) | The methods behind the numbers — Black-76 and the greeks, the arbitrage-free SVI surface, the risk-neutral density, martingale optimal transport, perpetual liquidation, fractional Kelly, impermanent loss, the microstructure estimators. |
| [**Verification**](docs/verification.md) | How the claims are held up: the invariant suite, ground-truthing against live venues, the population-scale crash study and the ablation it did not survive intact, the commissioned buyer audit, and the concurrency measurement. |
| [**Limitations**](docs/limitations.md) | What this does not do, each labelled structural or scheduled — including the largest one, which is that the envelope is signed by our own server. |
| [**Roadmap**](docs/roadmap.md) | What happens after the hackathon, the single metric that governs it, the unfinished engineering with definitions of done, and what would falsify the plan. |
| [**Roadmap after the proof**](docs/roadmap-after-the-proof.md) | The year after. The on-chain registry covers one computation of twenty-two; this is the ladder out of that, ending at the input problem that no amount of proving the arithmetic touches. |
| [**On-chain verification**](docs/onchain-verification.md) | The registry, the two transactions, and the commands to check them without our cooperation. |
| [**Checkable artifacts**](docs/checkable-artifacts.md) | Transaction hashes with block heights, the EAS schema, the research manifest, and a worked proof — each with the command that checks it. |
| [**API reference**](docs/api.md) | Every endpoint, its inputs and headline outputs, and every status the API returns with whether it costs anything. |
| [**Reproducing the build**](REPRODUCIBLE.md) | Rebuild the engine to an identical `codeHash`, re-run any deterministic answer, and recover the signer. |

Research artifacts — the crash study, its pre-registered queries, the beta calibration, the buyer
audit and its raw ledger — are under [`research/`](research/).

---

## The Risk Brain — deterministic, proof-carrying

Nine engines whose answers are pure functions of their inputs. Each ships the proof envelope, and
each is reachable free over `POST /mcp`.

| Service | What it does | Price |
|---|---|---|
| `perp-gate` | Perp liquidation price, distance-to-liq and funding drag — *derived* from the venue's stated liquidation condition, then verified against it on every call | 0.01 |
| `portfolio-gate` | Cross-venue **true** net exposure per underlying, the leg that liquidates **first**, concentration (HHI), and a correlated-crash stress | 0.05 |
| `size-gate` | Fractional-Kelly position size and risk of ruin, self-checked against the first-order condition that defines Kelly | 0.01 |
| `exec-verify` | Fair-fill / sandwich check — basis points lost to *adverse* execution beyond fee and own impact | 0.01 |
| `options-risk` | Portfolio greeks (delta, gamma, vega, theta, vanna, volga) and SPAN-style scenario margin, all six checked against finite differences of an independently repriced book | 0.02 |
| `lp-risk` | Forward-looking impermanent loss versus holding, and the fee break-even. Deliberately *not* labelled LVR — see [mathematics](docs/mathematics.md) | 0.01 |
| `treasury-risk` | Stablecoin-treasury concentration (HHI), depeg **and correlated-depeg** stress, risk-adjusted yield | 0.02 |
| `event-vol` | Options-implied expected move around a scheduled event (1σ, straddle E&#124;ΔS&#124;, probability-beyond) | 0.01 |
| `risk-attest` | Merkle batch of proof hashes → one root, inclusion proofs, and an EIP-712 (EAS-ready) attestation for a single on-chain anchor | 0.01 |

## Options, safety, microstructure and market intelligence

| Service | What it does | Price |
|---|---|---|
| `options-desk` | Arbitrage-free options analytics from Deribit: risk-neutral density, greeks, dealer gamma (GEX), variance risk premium, cross-market divergence, model-free calendar bounds | 0.01 |
| `calldata-x` | Transaction **and** EIP-712 signature safety: simulate a tx or decode a permit → asset and approval effects, spender reputation, proxy detection. The signature path covers the drainer vector simulators structurally cannot see | 0.005 |
| `lp-desk` | Concentrated-liquidity reality check: fees versus divergence loss, replayed on real on-chain swaps — and it refuses to name an optimum it cannot defend | 0.01 |
| `token-scan` · `wallet-audit` | Wash-trading share of DEX volume, with the wallets and transactions behind it · authenticity grade of a wallet's PnL and win rate | 0.05 |
| `chart-press` | Server-rendered PNG chart with indicators and drawings, and a facts block naming the source of each field | 0.02 |
| `tape-pulse` | DEX tape microstructure: Kyle's λ, Amihud illiquidity, VPIN — each with a quality gate that returns null rather than a false number | 0.01 |
| `poly-fill` · `poly-desk` · `updown-pulse` | Order-book fill simulation · wallet book and unrealised PnL · short-window up/down read that deliberately outputs no edge | 0.01 |
| `protocol-pulse` · `macro-sentry` · `loop-digest` | DeFi protocol risk flags from TVL and hack history · macro-event lookahead with implied move · cursor-based wallet diff for agent loops | 0.005–0.01 |

## How a call works

```
agent ──POST /api/perp-gate───────────────────────────▶ Quiver
      ◀─402 Payment Required {asset, amount, payTo, network}   (one entry per rail)
      ──POST + PAYMENT-SIGNATURE (EIP-3009, gasless)──▶
                                     verify + settle ─▶ facilitator
      ◀─200 {result, proof} + PAYMENT-RESPONSE receipt
```

Every paid route answers an unauthenticated request with the `402` challenge *before* any business
logic runs. **A request the engine refuses is never settled:** the receipt reads `not_charged` and
you keep your money.

## Running it

```bash
npm ci
npm test      # 386 model-free tests — no network access required
npm start     # serves on the configured port
```

The core suite is self-contained, so the invariants can be verified offline.

## License

MIT — see [LICENSE](LICENSE).
