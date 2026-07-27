# Quiver

**The verifiable risk brain for autonomous agents.** Twenty-two priced quantitative computations an
agent calls over HTTP, pays for in-band with [x402](https://github.com/coinbase/x402), and discovers
through the [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) trustless-agent registry. No chat, no
human in the loop. Every deterministic answer arrives with a proof you can re-derive yourself.

- **Live endpoint:** https://quiver-production-c3a8.up.railway.app — [`/build`](https://quiver-production-c3a8.up.railway.app/build) and [`/paper`](https://quiver-production-c3a8.up.railway.app/paper) are free; the paper is also served as plain markdown in six AI-readable parts at `/paper/1` … `/paper/6`
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
| **Traction, honestly** | Near zero, and stated against our own definition rather than a flattering one. Three external wallets have paid, for one or two calls each; at least one returned for a second, none went further. Everything else is our own disclosed quality-assurance traffic and is never counted as sales. |
| **Tests** | **372** model-free tests, 367 passing, 5 skipped for want of an archive node, 0 failing. Many provably fail on the pre-fix code — verified by reverting each fix and watching them go red. |
| **What it refuses to do** | Output a directional edge. Infer dealer positioning it cannot measure. Call a variance premium significant when it is not. Guess when the data is missing — it answers `DATA_UNAVAILABLE`, for free. |

---

## Documentation

The full technical documentation is one continuous document, served as
[`/paper`](https://quiver-production-c3a8.up.railway.app/paper) — typeset, with figures, mirrored at
[`assets/whitepaper.html`](assets/whitepaper.html)
([PDF](https://drive.google.com/file/d/1K44jmBBLyFed1qF6Ib62YRh8J-jMQ-xW/view?usp=sharing)).

**Reading it with an AI?** That page is 400 kB of styled HTML and will not arrive whole in one fetch.
The identical text is served as plain markdown in six parts, each small enough to read in a single
request. **Nothing is abridged** — the parts concatenate to the whole document, cut only at section
boundaries, and [a test](test/paperMachineReadable.test.mjs) asserts exactly that.

| | |
|---|---|
| [`/paper/1`](https://quiver-production-c3a8.up.railway.app/paper/1) | Abstract · At a Glance · Contents · 1 Introduction · 2 System Architecture · 3 Design Principles |
| [`/paper/2`](https://quiver-production-c3a8.up.railway.app/paper/2) | 4 Service Catalogue |
| [`/paper/3`](https://quiver-production-c3a8.up.railway.app/paper/3) | 5 Methodology |
| [`/paper/4`](https://quiver-production-c3a8.up.railway.app/paper/4) | 6 Verification and Testing · 7 Worked Walkthrough · 8 Limitations · 9 Related Work |
| [`/paper/5`](https://quiver-production-c3a8.up.railway.app/paper/5) | 10 The Build · 11 Roadmap · 12 Conclusion |
| [`/paper/6`](https://quiver-production-c3a8.up.railway.app/paper/6) | Appendix A API · Appendix B Reproducibility · Appendix C Checkable Artifacts · References |
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
npm test      # 372 model-free tests — no network access required
npm start     # serves on the configured port
```

The core suite is self-contained, so the invariants can be verified offline.

## License

MIT — see [LICENSE](LICENSE).
