# Quiver — Technical Documentation — part 1 of 6

> The complete document, split only because a single fetch truncates. **Nothing is abridged**: the
> parts below concatenate to the whole text, cut at section boundaries. Every part is served as plain
> markdown.
>
> - **Part 1** — `/paper/1` — Abstract  |  At a Glance  |  Contents  |  1. Introduction  |  2. System Architecture  |  3. Design Principles
> - **Part 2** — `/paper/2` — 4. Service Catalogue
> - **Part 3** — `/paper/3` — 5. Methodology
> - **Part 4** — `/paper/4` — 6. Verification and Testing  |  7. Worked Walkthrough  |  8. Limitations and Honest Disclosures  |  9. Related Work and Positioning
> - **Part 5** — `/paper/5` — 10. The Build: Story, Process, and a User Scenario  |  11. Roadmap: Operating Quiver After the Hackathon  |  12. Conclusion
> - **Part 6** — `/paper/6` — Appendix A · API Reference  |  Appendix B · Reproducibility  |  Appendix C · Checkable Artifacts  |  References
>
> Whole document in one response (239 kB, may truncate in your client): `/paper/full`
> Typeset edition with figures: `/paper/human`
> Live service: https://quiver-production-c3a8.up.railway.app · Source: https://github.com/Tristan-tech-ai/Quiver

---

## Abstract

Registered on X Layer as ERC-8004 agent #5152 under the name *Veritape* and renamed *Quiver* on 19 July 2026, so the on-chain record and the repository (`github.com/Tristan-tech-ai/Quiver`) carry different names for the same agent. Engine build behind every proof here: `q1-6f46d53490b3a29f`.

Autonomous trading and wallet agents now move real value on a loop — on the order of 69,000 agents and 169M+ x402 transactions in 2026 [69],[70] — yet they cannot perform the deterministic financial mathematics that keeps them solvent: in a benchmark of numerical reasoning over real financial tables, general-purpose models fail 10–20% of the most complex multi-step calculations even at the top of the field, and the smaller open-weight models fail almost all of them [71], and an autonomous agent lost 62% of its capital trading perpetuals with no human oversight [72]. The agent risk layer now shipping from exchanges and startups enforces user-set *limits* but does not *compute* the numbers those limits are checked against, and most agent-facing services return figures whose derivation cannot be verified. Quiver is an Agentic Service Provider (ASP) that supplies the missing layer: twenty-two priced quantitative computations, the deterministic subset marked row by row in Table 1, quantitative computations over the x402 payment protocol [39] and the ERC-8004 trustless-agent registry [38], spanning options analytics, liquidity-provision and market microstructure, transaction-safety analysis, prediction-market execution, and a **Risk Brain** — perpetual-futures liquidation and funding risk, fractional-Kelly position sizing with risk-of-ruin, and execution-quality (fair-fill) verification. Its defining property is **verifiability**, and it comes in two grades that this paper is careful not to conflate. Where a computation is deterministic, the answer ships a *proof envelope* — the echoed inputs, the exact code identity, a content hash, and a self-check that tests the output against the condition it was solved from — which catches an implementation error but shares its assumptions with the model, so it cannot catch a wrong input or a wrong model, as Section 5.19 states plainly — (the liquidation condition, the Kelly optimality FOC, the constant-product `k`, the martingale `E[S_T]=F`, the arbitrage-free density). Where an answer depends on a live market read, no re-run promise is possible and the service says so: it ships a signed, timestamped *observation envelope* instead, and the distinction is enforced in code rather than left to the reader. The caller re-runs the open engine and reproduces the number rather than trusting the provider — a guarantee LLM-based tools cannot cheaply make. The options service fits an arbitrage-free SVI volatility surface [5],[6] per expiry and recovers the risk-neutral density by the Breeden–Litzenberger identity [4]; on live Deribit chains it produces a full terminal-price distribution whose mean reproduces the forward to within 0.001% (the martingale condition), and a probability ladder that corrects the standard `N(d2)` figure — a correction whose size is a function of the skew it is fed, and which was measured at up to five percentage points on a smile we *constructed* with realistic skew rather than captured from a venue, so that figure is not a live-market measurement and Section 5.3 says which it is. The transaction-safety service simulates an unsigned transaction and also decodes EIP-712 permit signatures [32],[33], closing the signature-drainer gap that transaction simulators structurally cannot see. The tape service computes Kyle's lambda [15], Amihud illiquidity [16], and VPIN [17] on the live DEX tape. Every quantitative claim is locked by an automated suite of 354 model-free tests — many of which provably fail on the pre-fix code — and, beyond the suite, the risk engine was validated against the real market at population scale: replayed over every open position on a live derivatives venue before the October 10, 2025 crash (79,386 accounts, $14.6B), and then held to a **pre-registered, out-of-sample** test on two 2026 crashes it had never seen, where distance-to-liquidation — read from the venue's own published liquidation price rather than computed by this engine, a distinction Section 6 draws explicitly because it bounds what the study proves — predicted liquidation out-of-sample: flagged accounts were liquidated at **2.1× the base rate**, catching about nine in ten of the accounts it could see beforehand — about two in three of every liquidation once accounts that opened after the snapshot are counted — while flagging four in ten of all accounts, which expressed as a relative risk against the cleared cohort is 14.3× and 13.3× (Section 6). Two qualifications belong with that number rather than after it: the flag fires on 41.6% of accounts in February and 43.8% in June, and an ablation reported in the same section shows the result reduces to raw distance-to-liquidation, with the beta scaling contributing nothing measurable, which also means the naive baseline a sceptic would ask for was present in the study from the start rather than absent from it. Every one of the twenty-two services has also been purchased end-to-end with real money on both payment rails and its response verified client-side. The guiding principle is stated plainly and enforced throughout: where a signal cannot be grounded in observable data, or verified against an invariant, the service refuses to emit it rather than fabricate precision.


## At a Glance

One page, for a reader with thirty documents to get through. Everything here is expanded, sourced, or qualified later; nothing here is stated more strongly than the section it points to.

| What it is | An Agentic Service Provider: twenty-two priced computations an autonomous agent calls over HTTP, pays for in-band with x402, and discovers through ERC-8004. No chat, and no human workflow: the one service that renders an image does so for an agent to attach to a message. |
| --- | --- |
| Who calls it | Trading and wallet agents, inside a decision loop. Prices run 0.005 to 0.05 USD per call, cheap enough to poll before acting. |
| The one idea | An agent should not have to trust a number it just bought. Deterministic answers ship a *proof envelope* (echoed inputs, code identity, content hash, and a self-check against the condition the answer was solved from) that lets the caller re-derive the result. That check catches an implementation error; it cannot catch a wrong input or a wrong model, and Section 5.19 says so. Live-market answers cannot make that promise, so they ship a signed, timestamped *observation envelope* instead, and say which they are. |
| What it computes | Liquidation distance and funding drag, correlated-crash portfolio stress, Kelly sizing and risk of ruin, arbitrage-free options analytics and greeks, execution-quality checks, LP and treasury risk, event volatility, transaction and EIP-712 signature safety, DEX microstructure, prediction-market fills, protocol health, and on-chain attestation of a day's answers. |
| The build behind every proof | Every proof in this document comes from engine build `q1-6f46d53490b3a29f`, served live at `/build`. It replaced `q1-bce7e7bccb16ea1b` on 26 July 2026 to close four correctness defects an adversarial reviewer with live access found; the worked proof in Appendix C was regenerated on the new build and re-verified end to end, and Section 11.5 records what changed and why the earlier freeze was broken. Two unfinished *improvements* remain held back (Section 11.4) — a defect and an enhancement do not meet the same bar. |
| Checkable in thirty seconds | Agent listing on X Layer, one x402 settlement on each rail, an EAS schema on Base, the build hash served at `/build`, and a worked proof whose content hash and signature a reader can reproduce. All in Appendix C, with the explorer links and the checks. |
| Strongest evidence | A population-scale replay of the October 2025 crash and two out-of-sample 2026 crashes: flagged accounts were liquidated at 14.3× and 13.3× the rate of cleared ones (Section 6). |
| Strongest counter-evidence, ours | Our own ablation shows that result reduces to raw distance-to-liquidation; the beta scaling we built a calibration study for contributes nothing measurable. That distance is the *venue's own published* liquidation price, not one this engine computed, so the study measures the quantity's predictive power and not our computation of it — which also means the naive baseline a sceptic would ask for was in the study all along, unlabelled. The flag also fires on 42–44% of accounts. All three are in Section 6, not buried. |
| Traction, honestly | Near zero. Three external wallets have each paid for one or two calls; none has returned for a third, so external recurrence is zero. Everything else is our own disclosed quality-assurance traffic, never counted as sales. The buyer audit in Section 6.5 was commissioned by us, so it is arm's length, not independent. |
| What it does not do | It refuses to output a directional edge, refuses to infer dealer positioning it cannot measure, reports a variance premium as insignificant because it is, and answers `DATA_UNAVAILABLE` for free rather than guessing. Section 8 labels every limitation as either structural or scheduled. |
| Where it runs | One container, one region, trial tier. Availability is measured from outside and published including the outages: 99.63% of cycles clean over the measured record in Section 8. Redundancy is roadmap work, not a claim. |


## Contents

1. 1Introduction 1.1 The gap: agents can pay, but there is little worth paying for
2. 1.2 Design stance and contributions

- 2System Architecture 2.1 The x402 payment loop

- 2.2 Identity and discovery under ERC-8004

- 2.3 Multi-service host and data plane

- 3Design Principles 3.1 Two questions this design invites, answered before they are asked

- 4Service Catalogue 4.1 options-desk

- 4.2 calldata-x

- 4.3 chart-press

- 4.4 tape-pulse

- 4.5 poly-fill, poly-desk, updown-pulse

- 4.6 protocol-pulse, macro-sentry, loop-digest

- 4.7 token-scan, wallet-audit

- 4.8 lp-desk

- 4.9 Risk Brain: perp-gate, size-gate, exec-verify, options-risk, portfolio-gate (lp-risk, treasury-risk, event-vol and risk-attest are specified in Section 5)

- 5Methodology 5.1 Black-76 and the option greeks

- 5.2 The arbitrage-free volatility surface

- 5.3 Risk-neutral density and the full distribution

- 5.4 Variance risk premium

- 5.5 Tape microstructure estimators

- 5.6 Dealer gamma exposure and barrier probabilities

- 5.7 Transaction and signature safety

- 5.8 Model-free calendar bounds by martingale optimal transport

- 5.9 Concentrated-liquidity value and divergence loss

- 5.10 Perpetual liquidation and funding

- 5.11 Position sizing and the probability of ruin

- 5.12 Execution quality and adverse fills

- 5.13 Options-book greeks and scenario margin

- 5.14 Liquidity-provision divergence and its LVR rate

- 5.15 Stablecoin-treasury concentration and depeg

- 5.16 Event-implied expected move

- 5.17 Batched attestation

- 5.18 Cross-venue portfolio exposure and correlated-crash stress

- 5.19 The proof envelope: correctness you re-derive

- 6Verification and Testing 6.1 Validation against the real market

- 6.2 The same result at its least flattering

- 6.3 An ablation the result did not survive intact

- 6.4 Independent buyer verification, and a defect it found in the money path

- 7Worked Walkthrough

- 8Limitations and Honest Disclosures

- 9Related Work and Positioning

- 10The Build: Story, Process, and a User Scenario 10.1 Starting from a gap

- 10.2 Choosing the set

- 10.3 Holding a standard, and what it caught

- 10.4 The record, dated

- 10.5 A day in an agent's loop

- 11Roadmap: Operating Quiver After the Hackathon 11.1 Standing commitments

- 11.2 The single metric that governs the plan

- 11.3 Sequence

- 11.4 Known gaps that are engineering work, not limits

- 11.5 Defects a live adversarial test found after the freeze, and how they were closed

- 11.6 A second review, and the reason its findings are worse than the first's

- 11.7 A third round, and the pattern that predicts what is still there

- 11.8 Research programme

- 11.9 What would falsify this plan

- 12Conclusion

- AAppendix A: API Reference

- BAppendix B: Reproducibility

- CAppendix C: Checkable Artifacts

- References


## 1. Introduction

A new class of software buyer has appeared on-chain. Autonomous agents now hold wallets, read markets, and sign transactions on a schedule, and with the arrival of the x402 protocol [39] they can pay for a service in-band over HTTP, settling in stablecoin without an account or a human in the loop. The supply side has not caught up. An agent that wants the risk-neutral probability that Bitcoin closes above a strike, or a verdict on whether a pending signature will drain its wallet, has almost nowhere to buy that computation in a form it can call and trust.


### 1.1 The gap: agents can pay, but there is little worth paying for

Two failures are common in the services that do exist. The first is reachability. The quantitative tooling that desks rely on, from volatility-surface fitters to market-impact models, lives in notebooks and internal libraries that expose no priced, machine-callable interface. An agent cannot invoke it. The second failure is trust. Many agent-facing endpoints return a number, a grade, or a score with no way to check how it was produced. A "health score of 73" or a "buy signal" is worthless to a counterparty that cannot audit the derivation, and worse than worthless if the number was fitted to look good. For financial and security computations, where a wrong answer moves real money, an unverifiable output is a liability.

Quiver is built for that gap. It is an Agentic Service Provider: a single host that publishes twenty-two independently priced computations, each callable by any agent that speaks x402, each registered on-chain under ERC-8004 [38] so it can be discovered and its reputation accrued. The services are not thin wrappers over a data feed. They implement the methods a quantitative desk or a security team would actually run, and they are written to a standard this document makes explicit: correctness is proven by test, claims are grounded in observable data, and when the data does not support a claim the service says so.


### 1.2 Design stance and contributions

The stance is adversarial toward its own output. Before a number is served, we ask what would have to be true for it to be wrong, and we check that against independent data. This produced several corrections during development that a looser process would have shipped. The plain `N(d2)` risk-neutral probability, standard in textbooks, carries a bias of up to five percentage points on a skewed crypto smile because it omits the volatility-slope term; we measured that bias on a smile constructed for the purpose, since the correction's size is a function of the skew it is given, and replaced the formula. A per-trade Amihud illiquidity ratio returned a value of order 10^9 on a live memecoin tape because sub-cent dust trades drive the denominator to near zero; ground-truthing caught it and the estimator was rebuilt on volume blocks. This document reports those corrections rather than hiding them, because the discipline that produced them is the product.

The contributions are the following.

1. A production ASP of twenty-two priced services on x402 and ERC-8004, live and paid end-to-end, covering options, transaction and token safety, microstructure, prediction markets, concentrated-liquidity economics, protocol risk, and a verifiable risk brain — perpetual-futures liquidation and funding, cross-venue portfolio risk (net exposure, nearest-liquidation, and a correlated-crash stress), fractional-Kelly sizing with risk-of-ruin, and execution-quality (fair-fill) verification.
2. A **proof envelope** on every risk computation: because the engines are deterministic, each answer carries its inputs, code identity, a content hash, and a self-check against the condition the answer was solved from, so a caller re-runs and reproduces the number instead of trusting the provider. What that self-check does and does not establish is stated precisely in Section 5.19: it catches an implementation error, and it shares its assumptions with the model, so it cannot catch a specification error.
3. An arbitrage-free options analytics stack: raw SVI fitted per expiry with the Gatheral–Jacquier butterfly and Roger Lee wing conditions enforced inside the objective [6],[8], the calendar condition enforced across expiries on the *shipped* surface rather than on a full-precision object the caller never receives, and the Breeden–Litzenberger density [4] policed by a coverage-honest butterfly check that reports the strike range it actually verified and withholds its verdict where the smile could not be evaluated.
4. Model-free no-arbitrage price bounds on calendar and forward-starting option payoffs via martingale optimal transport (Beiglböck, Henry-Labordère and Penkner [67]): given two fitted expiry marginals, a linear program returns the tightest lower and upper prices consistent with *every* arbitrage-free model, and its feasibility is exactly the Strassen convex-order condition certifying that the two smiles are jointly free of calendar arbitrage — a bound nobody assumes a dynamics to produce.
5. A concentrated-liquidity reality-check that reconstructs a Uniswap-V3 position's realised fees against its divergence loss from the pool's live on-chain swap history, read over a keyless public archive node, so the fee-versus-loss verdict is measured on real flow rather than assumed.
6. A transaction-safety service that combines on-chain simulation with EIP-712 permit-signature analysis [32], addressing the dominant modern drainer vector that pure simulators cannot observe.
7. Real market-microstructure estimators on the DEX tape: Kyle's lambda, Amihud illiquidity, and VPIN, with quality gates that return null rather than a false number on thin data.
8. A verification methodology: 354 automated tests of model-free invariants that run on every build, a further five live-archive integration tests behind an RPC flag, a ground-truthing protocol against live venues, and a pre-registered out-of-sample validation of the risk engine against real market crashes (Section 6) — with every reported figure reproducible by a documented request.

The remainder of the document is organised as follows. Section 2 describes the payment, identity, and hosting architecture. Section 3 states the design principles that constrain every service. Section 4 catalogues the twenty-two services. Section 5 gives the mathematics. Section 6 describes verification. Section 7 walks through live calls end to end. Section 8 is a candid account of what the services do not do. Section 9 positions the work, Section 10 recounts how it was built and how an agent uses it, Section 11 sets out what happens after the hackathon and what would falsify that plan, and Section 12 concludes.


## 2. System Architecture

Quiver is one HTTP server that hosts many services. Each service is a pure function from a typed request to a JSON response, gated by a payment middleware and registered as a callable capability. The design keeps the surface small: a request arrives, payment is verified, the service runs against live venue data, and a structured result returns in a single round trip.


### 2.1 The x402 payment loop

Payment uses x402, the protocol that revives the dormant HTTP 402 status code as a settlement channel [39]. The flow has three messages. An agent requests a paid route; the server answers `402 Payment Required` with a challenge that names the asset, amount, recipient, and network. The agent constructs a payment authorization and resends the request carrying it. The server verifies the authorization through a facilitator and, once settled, executes the service and returns the result. Quiver implements the v2 *exact* scheme, in which the client authorizes a transfer of a fixed amount to a fixed recipient. That scheme is built on EIP-3009 `transferWithAuthorization` [36], so the transfer is gasless and signed off-chain; the token is USD₮0 on X Layer (chain `eip155:196`) via the OKX facilitator, with a second settlement rail in USDC on Base (chain `eip155:8453`) through the Coinbase CDP facilitator, offered on the same 402 challenge. Prices are per call and range from 0.005 to 0.05 USDT, low enough that an agent can poll a service inside a decision loop without material cost.

The payment gate is enforced before any business logic. A route that is called without a valid authorization, whether by an honest probe or by the reviewer's conformance tool, receives the mandatory 402 challenge rather than a partial result or an error. This property is checked directly: at the time of writing, every paid route returns 402 to an unauthenticated request.

```
Agent                         Quiver host                    Facilitator / X Layer
  |   GET /api/options-desk        |                                |
  |------------------------------->|                                |
  |   402 Payment Required         |                                |
  |   {asset, amount, payTo, net}  |                                |
  |<-------------------------------|                                |
  |   GET + X-PAYMENT (EIP-3009)   |                                |
  |------------------------------->|   verify + settle              |
  |                                |------------------------------->|
  |                                |   settled                      |
  |                                |<-------------------------------|
  |   200 OK  {structured result}  |   (service runs against Deribit/OKX/…)
  |<-------------------------------|                                |
```


### 2.2 Identity and discovery under ERC-8004

An agent economy needs a way for one agent to find another and to judge whether it is worth transacting with. ERC-8004, the Trustless Agents standard [38], provides this with three on-chain registries: Identity, Reputation, and Validation. Identity is a portable ERC-721 token whose metadata points to a registration file describing the agent and its services. Reputation collects client feedback; Validation records independent checks of delivered work. Quiver is registered as ASP `#5152` on X Layer under this standard, which makes its twenty-two services discoverable to any agent browsing the registry and lets a track record accrue against a stable identity rather than a URL that can change. ERC-8004 is deliberately silent on payment and execution [38], which is what allows it to compose with x402 for settlement and with the A2MCP calling convention for invocation. The nine deterministic risk-brain engines are additionally exposed over a remote Model Context Protocol [41] (MCP) endpoint that any MCP-speaking agent can list and call directly, at `https://quiver-production-c3a8.up.railway.app/mcp`, registered on the public MCP registry as `quiver-risk-brain`.


### 2.3 Multi-service host and data plane

Every service is defined by a name, a price, an input schema, a validator, and a runner. The runner is asynchronous and calls out to the venue that owns the ground truth for that service: Deribit for options, the OKX DEX market API for token tape and candles, EVM JSON-RPC nodes for transaction simulation, the Polymarket Gamma and CLOB APIs for prediction markets, and DefiLlama for protocol data. Results are computed on demand; three caches exist, and each is named with its staleness bound rather than described as absent: a per-currency variance-risk-premium estimate held for twelve hours, which survives a transient upstream failure rather than turning it into a refusal; a rendered-chart store keyed by request so an image can be fetched again by URL; and the in-memory cursor store behind `loop-digest`, which expires after twenty-four hours and does not survive a restart, a limitation the service discloses in its own response rather than hiding. Nothing about a token's price, a book, or a market read is cached.

The host is stateless between calls except for the three stores named above that exist for good reasons: a rendered-chart store that lets an image be fetched by URL after the call that produced it, and a cursor store for the loop-digest service that lets an agent diff a wallet against its own previous call. Both are ephemeral and per-session. The separation of data plane from compute keeps each service auditable: given the same venue state, the same request produces the same result, and the result names the block or the tape window it was computed on so a caller can reproduce it.

Latency is bounded by the venue round trip rather than by the computation. Measured end to end, the transaction decode and simulation returns in roughly 125 to 160 milliseconds, the fast-tier chart in 220 to 300, and the full options desk, which fetches and normalises an entire Deribit chain and fits a surface across expiries, in 550 to 700. These are within the budget an agent can absorb inside a decision loop, which is the point of pricing calls low enough to poll. Every response carries an `elapsedMs` field so a caller can hold the service to its own timing.

**Table 1 — the twenty-two registered services, their data source, and per-call price.**

| Service | Function | Primary data source | Price (USDT) |
| --- | --- | --- | --- |
| `options-desk` | Options analytics: surface, greeks, RND, GEX, VRP, cross-market | Deribit v2, OKX | 0.01 |
| `calldata-x` | Transaction simulation and EIP-712 signature safety | EVM JSON-RPC | 0.005 |
| `chart-press` | Server-rendered PNG chart with indicators and drawings | OKX DEX candles | 0.02 |
| `tape-pulse` | DEX tape microstructure: Kyle λ, Amihud, VPIN | OKX DEX trades | 0.01 |
| `poly-fill` | Order-book fill simulation and market impact | Polymarket CLOB | 0.01 |
| `poly-desk` | Polymarket wallet book and unrealised PnL | Polymarket | 0.01 |
| `updown-pulse` | Short-window up/down market read (no fabricated edge) | Polymarket, OKX | 0.01 |
| `protocol-pulse` | DeFi protocol risk flags from TVL and hack history | DefiLlama | 0.01 |
| `macro-sentry` | High-impact US macro events ahead + the options-implied expected move to the next one | Curated calendar + ATM IV | 0.005 |
| `event-vol` | Options-implied expected move around an event (1σ + straddle E\|ΔS\| + prob-beyond) & event-isolation from the vol term structure, self-checked | Black-76 (deterministic) | 0.01 |
| `loop-digest` | Cursor-based wallet diff for agent loops | OKX DEX | 0.01 |
| `lp-desk` | Concentrated-liquidity fees vs divergence loss, replayed on real swaps | Uniswap-V3 (keyless RPC) | 0.01 |
| `token-scan` | Wash-trading share of DEX volume, with wallet/tx evidence | OKX DEX trades | 0.05 |
| `wallet-audit` | Authenticity grade of a wallet's PnL and win rate | OKX portfolio | 0.05 |
| `perp-gate` | Perp liquidation price, distance-to-liq & funding drag, with a liquidation-invariant self-check | Hyperliquid / dYdX (live) + inputs | 0.01 |
| `portfolio-gate` | Cross-venue net exposure per underlying, the leg that liquidates first, concentration (HHI), and a correlated-crash stress | Hyperliquid, dYdX (live) | 0.05 |
| `size-gate` | Fractional-Kelly size + risk-of-ruin, with a Kelly-optimality self-check | Edge inputs (deterministic) | 0.01 |
| `exec-verify` | Fair-fill / sandwich check — bps lost to adverse execution, with a constant-product self-check | Swap + pool state (deterministic) | 0.01 |
| `options-risk` | Portfolio greeks + SPAN-style scenario margin for an options book, self-checked against finite differences | Black-76 (deterministic) | 0.02 |
| `lp-risk` | Forward-looking LP *impermanent loss* — expected divergence versus holding at the horizon, deliberately not labelled LVR (Section 5.14) — plus fee breakeven, self-checked at the token level | Closed-form (deterministic) | 0.01 |
| `treasury-risk` | Stablecoin-treasury concentration (HHI), depeg and correlated-depeg stress, and risk-adjusted yield, self-checked | Deterministic | 0.02 |
| `risk-attest` | Merkle-batch of proof hashes → one root + inclusion proofs + an EIP-712 (EAS-ready) attestation for a single on-chain anchor | Deterministic | 0.01 |


## 3. Design Principles


### 3.1 Two questions this design invites, answered before they are asked

**If the caller can re-run the engine to check the answer, why pay for the answer?** The re-run is a check, not a substitute, and the difference is the whole reason the service exists. An agent that wants a liquidation price has three options: ask a language model to do the algebra, which the published benchmarks put at a 10–20% failure rate on multi-step calculation even for the strongest models, and near-total failure for smaller ones [71]; implement the venue's margin regime itself, which means tracking notional-tiered maintenance rates, cross-margin account-value definitions, funding accrual and per-venue liquidation conventions that change without notice; or buy a number that arrives with a self-check proving it satisfies the venue's own liquidation condition. Verification is cheap because the artifact is small; getting it right the first time is not, which is precisely why the arithmetic is worth half a cent and the checking is free. The proof envelope does not exist so the caller can avoid paying. It exists so the caller can pay without trusting.

**What is an observation envelope actually worth, given it cannot promise a re-run?** Less than a proof, and it is important to say what the "less" consists of rather than leave it implied. An observation envelope establishes four things: which engine produced the answer, on which build, from which upstream source, at which instant, signed by a key published in the agent card. It establishes nothing about whether the number is right. What it buys a caller is accountability rather than correctness — the ability to hold a specific answer, from a specific version, at a specific time, against what the market later did, and to do so months later without the provider's cooperation. That is the honest ceiling of a live-data guarantee from any provider, and the reason this document separates the two envelope kinds in code rather than describing both as "verifiable". A reader who concludes that the strong guarantee attaches to the arithmetic and the weak one to the data has read the design correctly; the response to that is not to overstate the weak one but to be explicit about which services carry which, which Table 1 does row by row.

Five principles constrain every service. They are not aspirations; each is enforced somewhere in the code and testable.


### 3.2 Ground truth over self-report

A computed signal is validated against an independent source or an analytic identity before it ships. The risk-neutral density is checked against the martingale condition that its mean must equal the forward. Analytic greeks are checked against finite differences of the price. The variance risk premium is checked against a significance test at the honest effective sample size, not the inflated count of overlapping windows. Where ground truth disagreed with a first implementation, the implementation changed.


### 3.3 Refuse to fabricate

When a quantity cannot be estimated from observable data, the service returns null with a reason rather than a plausible-looking number. The tape microstructure estimators return null on a tape too thin to support them. The options surface excludes near-expiry slices where a diffusive model does not apply, rather than force-fitting them. The short-window up/down service outputs no directional edge at all, because short-horizon direction is empirically indistinguishable from a coin flip and a fabricated fair value would contradict the product's own thesis.


### 3.4 Arbitrage-free by construction

The volatility surface is fitted with the no-arbitrage inequalities enforced inside the optimisation objective, so an accepted fit satisfies them by construction rather than by hope [6]. Three conditions are enforced, not one: the butterfly condition per slice, the Roger Lee wing bound, and — the one most easily overlooked — the calendar condition *between* slices, checked on the rounded parameters the caller actually receives rather than on the full-precision fit, because rounding a slice can reintroduce a crossing the fit had eliminated. A fit that fails its quality gate is rejected, and the caller is told the fallback was used. A negative risk-neutral density, the signature of butterfly arbitrage, is detected and disclosed rather than silently served; the check reports the strike range over which it was able to evaluate the density and withholds a clean verdict where the smile could not be evaluated, so "no arbitrage detected" can never mean "detected none over the sliver I could see."


### 3.5 Descriptive, not prescriptive

Services report what the market prices and what the data shows. They do not tell a caller what to do. A composite "grade" that implies a validated predictive model is avoided where no labelled dataset exists to validate it; the protocol-risk service was rebuilt from a fitted 0–100 score into a set of individually defensible risk flags for exactly this reason. Every output that touches a trading decision carries a not-advice disclosure.


### 3.6 Proven by test

The financial mathematics is locked by an automated suite of model-free invariants: put-call parity, the delta relationship, non-negativity of the risk-neutral density, the martingale property of the distribution, and the absence of look-ahead in every time-series indicator. A change that breaks an identity breaks the build. Section 6 describes the suite; it currently holds 354 tests that run on every build, with a further five live-archive integration tests that are SKIPPED unless an archive RPC is configured. None of the 333 fails; the five are not run in the default environment, and calling that "all pass" — as this sentence did — counted a test that never executed as a passing one.

---

**Continues in part 2 of 6: `/paper/2` — 4. Service Catalogue**
