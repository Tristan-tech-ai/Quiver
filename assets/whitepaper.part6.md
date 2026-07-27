# Quiver — Technical Documentation — part 6 of 6

> The complete document, split only because a single fetch truncates. **Nothing is abridged**: the
> parts below concatenate to the whole text, cut at section boundaries. Every part is served as plain
> markdown.
>
> - **Part 1** — `/paper/1` — Abstract  |  At a Glance  |  Contents  |  1. Introduction  |  2. System Architecture  |  3. Design Principles
> - **Part 2** — `/paper/2` — 4. Service Catalogue
> - **Part 3** — `/paper/3` — 5. Methodology
> - **Part 4** — `/paper/4` — 6. Verification and Testing  |  7. Worked Walkthrough  |  8. Limitations and Honest Disclosures
> - **Part 5** — `/paper/5` — 9. Related Work and Positioning  |  10. The Build: Story, Process, and a User Scenario  |  11. Roadmap: Operating Quiver After the Hackathon  |  12. Conclusion
> - **Part 6** — `/paper/6` — Appendix A · API Reference  |  Appendix B · Reproducibility  |  Appendix C · Checkable Artifacts  |  References
>
> Whole document in one response (238 kB, may truncate in your client): `/paper/full`
> Typeset edition with figures: `/paper`
> Live service: https://quiver-production-c3a8.up.railway.app · Source: https://github.com/Tristan-tech-ai/Quiver

---

## Appendix A · API Reference

All services are reached at `https://quiver-production-c3a8.up.railway.app`. Each paid route answers an unauthenticated request with the x402 `402` challenge; a request carrying a valid payment authorisation receives the JSON result. Inputs are passed as query parameters on a GET or as a JSON body on a POST.

**Table 8 — endpoints and principal inputs. Outputs are structured JSON; the key fields are named in Section 4.**

| Endpoint | Principal inputs | Headline output fields |
| --- | --- | --- |
| `POST /api/options-desk` | `currency` (BTC/ETH/SOL), `focus` | `impliedView`, `distribution`, `gex`, `vrpModel`, `crossMarket` |
| `POST /api/calldata-x` | `data`, `to`, `from`, `chain`, or `typedData` | `alert`, `verdict`, `simulation`, `spenderReputation`, `targetContract` |
| `POST /api/chart-press` | `chain`, `address`, `interval`, `chartType`, `indicators`, `drawings` | `hostedUrl`, `imageBase64`, `facts` |
| `POST /api/tape-pulse` | `chain`, `address` | `read`, `microstructure`, `dataWindow` |
| `POST /api/poly-fill` | `market`, `side`, `usd`, `maxSlippagePct` | `fill`, `marketImpact`, `bookDepth`, `bookWalk` |
| `POST /api/poly-desk` | `wallet` | `positions`, `unrealizedPnl`, `movers` |
| `POST /api/updown-pulse` | `coin` (BTC/ETH) | `marketImplied`, `window`, `remainingRisk`, `edgeStance` |
| `POST /api/protocol-pulse` | `protocol` | `riskLevel`, `riskFlags`, `tvl`, `incidents` |
| `POST /api/macro-sentry` | `hours` (+ optional `spot`, `atmIvPct` for the implied move) | `events`, `nextHighImpact` |
| `POST /api/loop-digest` | `wallet`, `chain`, `cursor` | `newFills`, `pnlDrift`, `cursor` |
| `POST /api/perp-gate` | `symbol` (or `entryPrice`), `side`, `size` or `notional`, `margin` or `leverage`, optional `venue` | `liquidationPrice`, `moveToLiquidationPct`, `marginTier`, `funding`, `proof` |
| `POST /api/portfolio-gate` | `positions` (legs) or `account`, optional `betaTier`, `shockScenariosPct` | `netExposure`, `firstLegToLiquidate`, `correlatedStress`, `proof` |
| `POST /api/size-gate` | `winProb` + `winLossRatio` (or `expectedReturn` + `volatility`), `bankroll`, `kellyFraction` | `recommendedSize`, `fullKellyFraction`, `expectedLogGrowth`, `riskOfRuin`, `proof` |
| `POST /api/exec-verify` | `amountIn`, `amountOutRealized`, `reserveIn`/`reserveOut` or `fairPrice`, `feeTier` | `slippageBps`, `priceImpactBps`, `verdict`, `proof` |
| `POST /api/options-risk` | `positions` (legs), `forward`, optional `scanRangePct`, `volShiftVolPts` | `netGreeks`, `scenarioGrid`, `worstCase`, `proof` |
| `POST /api/lp-risk` | `priceRatio` or `volatility` + `horizonPeriods`, `feeAprPct`, `concentrationFactor`, `capitalUsd` | `impermanentLossPct`, `breakEvenFeeApr`, `netVsHodl`, `proof` |
| `POST /api/treasury-risk` | `positions` (holdings), `concentrationLimitPct`, `depegScenarios` | `concentration`, `depegImpact`, `flags`, `proof` |
| `POST /api/event-vol` | `spot`, `atmIvPct`, `daysToEvent`, optional `thresholdsPct`, `ivBeforePct` | `impliedMove`, `thresholdProbabilities`, `ivCrush`, `proof` |
| `POST /api/risk-attest` | `items` (envelopes) or `contentHashes` | `merkleRoot`, `inclusionProofs`, `anchorCalldata`, `proof` |
| `POST /api/token-scan` | `chain`, `address` | `manipulationRisk`, `evidence`, `verdict` |
| `POST /api/wallet-audit` | `chain`, `address` | `trackRecord`, `significance`, `washCrossCheck`, `grade` |
| `POST /api/lp-desk` | `pool`, `chain`, `days`, `widthPct`, `capital` | `feesEarned`, `impermanentLoss`, `netVsHodl`, `verdict` |


### The challenge an unpaid request receives

A caller does not need this document to learn how to call a service, because the `402` carries that information itself. Every unpaid request returns both payment rails and, inside each, a JSON Schema for the request body — including the *alternative* ways to satisfy it, which is the part a flat parameter list cannot express. The abridged reply below is what `POST /api/perp-gate` answers with today.

```
{
  "x402Version": 2,
  "accepts": [{
    "scheme": "exact",  "network": "eip155:8453",
    "maxAmountRequired": "10000",           // 0.01 USDC, 6 decimals
    "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "payTo": "0x65bb932d9987f1d1a98b8942a3fa98cb28ec073b",
    "maxTimeoutSeconds": 300,
    "resource": { "url": ".../api/perp-gate", "description": "...", "mimeType": "application/json" },
    "extra": { "name": "USD Coin", "version": "2" },      // EIP-712 domain for the authorisation
    "outputSchema": { "input": { "type": "http", "method": "POST", "bodyType": "json", "body": {
      "type": "object",
      "properties": { "symbol": {...}, "side": {...}, "entryPrice": {...}, "size": {...}, ... },
      "allOf": [
        { "anyOf": [{"required":["entryPrice"]}, {"required":["symbol"]}],
          "description": "price: entryPrice OR symbol (defaults to live mark)" },
        { "anyOf": [{"required":["size"]}, {"required":["notional"]}],
          "description": "size: size (base units) OR notional" },
        { "anyOf": [{"required":["margin"]}, {"required":["leverage"]}],
          "description": "collateral: margin OR leverage" },
        { "anyOf": [{"required":["maintMarginRate"]}, {"required":["maxLeverage"]}, {"required":["symbol"]}],
          "description": "maintenance: maintMarginRate OR maxLeverage OR symbol" }
      ] } } }
  }, { "network": "eip155:196", "asset": "0x779Ded...3736", "extra": {"name":"USDT","version":"2"}, ... }],
  "error": "Payment required"
}
```

The `allOf` of `anyOf` groups is the load-bearing detail. `perp-gate` needs a price, a size, collateral, and a maintenance rate, and each of those can arrive in more than one way — a symbol resolves three of them from live venue data at once. An agent reading the schema can construct a valid call without a human in the loop and without guessing, which is the difference between a machine-readable price tag and a machine-readable *interface*. The `extra` block is the EIP-712 domain the payment authorisation must be signed under, so the payer needs nothing from us beyond this response.


### Failure modes, and which of them cost money

Only one rule matters here and it is worth stating before the table: **a request the engine refuses is never settled.** When a result carries `ok: false` the payment authorisation is not submitted, and the reply carries a `PAYMENT-RESPONSE` receipt reading `{ success: false, status: "not_charged", reason: "input rejected by engine — no settlement" }`. A caller can therefore probe a service, get a refusal explaining what was missing, and pay nothing for it. This was not always true — Section 6.4 records the leak that made it true and the buyer who measured it.

**Table 9 — every status the API returns, what causes it, and whether it costs the caller anything. Captured against the live service.**

| Status | Body | Cause | Charged? |
| --- | --- | --- | --- |
| `200` | the result, with its `proof` or `observation` envelope | Valid payment, valid input. | Yes — receipt carries the settlement transaction hash |
| `200` | `ok: false` with a reason and, where relevant, a coverage note | The data does not support an answer: a venue returned nothing, a window held too few observations, a smile could not be fitted. The service refuses rather than interpolating. | **No** — receipt reads `not_charged` |
| `400` | `{ error: "bad_input", note: … }` | Input fails the schema, or the body is not parseable JSON at all. An unparseable body used to fall through to the 500 handler and echo the raw parser message, reporting a caller error as a fault inside the service; it is a 400 now. The `note` is self-teaching on *both* paths: it names what was missing, or that the body would not parse, and then the service, its purpose, and every alternative required-field group, so the caller can fix the request from the error alone. An earlier version of this row claimed that of both paths when it was true of only one — the parse case returned a generic sentence about invalid JSON and stopped there. The route is known even when the body is not, so the hint was added to that path rather than the claim narrowed to fit. The parse case also returns `parserDetail`, the runtime's own message naming the character position that failed, which is the one thing a caller cannot work out from its own request; it discloses which JSON parser is in use and nothing about this service's data or state. | **No** |
| `402` | the challenge above | No payment header — or a malformed, expired, or forged one. An invalid authorisation is re-challenged rather than answered, so a forged header cannot buy a computation. | **No** |
| `404` | `{ error: "not_found", note: "no route …", index: "/", docs: "/paper" }` | Unknown service. The reply names the route it did not find and points at the index and this document. | **No** |
| `429` | `{ error: "rate_limited", note: "max 60 requests/min per IP" }` | Sixty requests per minute per IP, applied before the payment surface, so it costs an abusive caller nothing and costs us nothing either. | **No** |
| `413` | `{ error: "bad_input", note: … }` | Body over the 16 kb limit, on a route with no payment gate in front of it. On a *paid* route an oversized body is answered with the 402 challenge instead, because the payment gate is evaluated before the body is read — verified live at 40 kb. An earlier version of this row claimed the 413 for paid routes too, which was written from the handler rather than from a test. | **No** |
| `500` | `{ error: "engine_error", detail: … }` | An unhandled fault inside a service. Distinguished from a refusal on purpose: a refusal is a correct answer about missing data, this is a bug. | **No** |
| `502` | `{ error: "facilitator_unreachable", detail: … }` | The payment facilitator did not answer verification or settlement. Reported as an upstream failure rather than folded into a generic 500, because the caller's next action differs: retry, or switch rails. | **No** |

The free MCP endpoint at `POST /mcp` meters tool *calls* only — `initialize` and `tools/list` are unmetered so a client can always discover the surface — at three hundred calls per day per IP. Exceeding it returns a JSON-RPC error `-32000` whose message names the quota and points at the paid x402 route with both rails, rather than failing silently or degrading the answer.


## Appendix B · Reproducibility

The figures in this document divide into three kinds, and only one of them involves a venue: Figures 2 to 5 are deterministic mathematics that reproduce from the equations alone, the crash study reproduces from a public requester-pays archive, and the captured service responses reproduce against live venues only in the sense that the method repeats — a live number cannot be reproduced once the market has moved. Appendix C carries the artifacts that reproduce exactly. Because reproduction of a live number requires the live market to be in a comparable state, the figures should be read as representative of the method rather than as constants.

- **Options distribution and martingale check (Section 7).** Call `options-desk` with `currency=BTC` and read `impliedView[0].distribution`. The `selfCheck.meanVsForwardPct` field is the martingale residual of equation (9) and should be near zero on any well-formed chain.
- **Probability correction (Section 5.3).** The `probabilityLadder` reports both the corrected probability and the field `skewCorrectionPts`, the size of the smile-slope term of equation (8) at each level. Independently, fetch the Deribit ticker greeks for the same instruments and confirm the delta matches to three or four decimals.
- **Signature and proxy safety (Section 7).** Call `calldata-x` with an `approve(spender, MAX_UINT)` calldata, `to` a token, and `from` any funded address; vary the spender between a known router and a wallet to see the verdict flip. Re-run `eth_simulateV1` with the same inputs on any node to confirm the emitted Transfer and Approval logs.
- **Tape microstructure (Section 5.5).** Call `tape-pulse` on a liquid token; the `tape.medianGapSeconds` field indicates whether the read rests on a dense or a sampled feed, and Kyle's lambda carries its own R-squared and confidence.
- **Market impact (Section 7).** Call `poly-fill` on a live market; `marketImpact.fitR2` is the measured quality of the square-root fit, and `bookDepth.imbalance` is computed from the same book that the walk consumes.

Everything referenced in this appendix lives in the public repository: `https://github.com/Tristan-tech-ai/Quiver` — the full engine source, the test suite, and the research artifacts under `research/` (the crash study, the validation scripts, and the field-test harnesses with their raw results). The invariant test suite is self-contained and deterministic; it runs with the project's standard test command and requires no network access, so the 362 model-free properties of Section 6 can be verified offline. The market-validation numbers of Section 6 reproduce from public data with the scripts in `research/reservoir-data/` (episode detection, beta measurement, and the two pre-registered event tests; about $1 of requester-pays S3 access — the folder's README gives the exact fetch commands).


## Appendix C · Checkable Artifacts

A reviewer of an earlier draft of this document made an observation that was both correct and embarrassing: a paper whose thesis is *do not trust the number, re-derive it* shipped almost nothing a reader could re-derive. Every figure in the preceding sections is an assertion by us. This appendix exists to fix that. Each row below is an artifact that lives outside this document, on a public chain or a public endpoint, together with the command that checks it. None of them requires our cooperation, and none can be edited by us after the fact. If any of them fails to resolve as stated, treat the corresponding claim in this document as unproven.

**Table 10 — artifacts a reader can verify without contacting the authors. Verified as resolving at the time of writing; a reader should expect them to resolve identically. Each transaction hash, its success status, and the schema were verified on 26 July 2026 by direct RPC call to each chain and, for the schema, by `getSchema` against the Base SchemaRegistry. Block heights are given in hex as returned by `eth_getTransactionReceipt` alongside the decimal, because an earlier draft of this table converted them by hand and got all four wrong — an error found by a reviewer who ran the checks this appendix invites, which is the appendix working as intended and the authors not.**

| What | Artifact | Where it lives |
| --- | --- | --- |
| ERC-8004 agent listing registered as *Veritape* and renamed to Quiver on 19 July, so the on-chain name may differ from this title page | `0x25326e5504e5213b1a8f9dce81818157a3995ea49b17e8f1d0987fa0f1b78e7d` | X Layer (`eip155:196`), block 65,692,173 (`0x3ea620d`) www.oklink.com/xlayer/tx/0x25326e55… |
| x402 settlement, X Layer rail (USD₮0) | `0x68444c5462bddecd1a587b762d3f7b8f2f4bce2724fa3bc04dcacdadd7cba1af` | X Layer (`eip155:196`), block 65,848,752 (`0x3ecc5b0`) www.oklink.com/xlayer/tx/0x68444c54… |
| x402 settlement, Base rail (USDC) | `0x429a1efe31a82078bb61bc781435c09038adb3dd07d0d7641a2496a5fbb42483` | Base (`eip155:8453`), block 48,956,716 (`0x2eb052c`) basescan.org/tx/0x429a1efe… |
| Second Base settlement, different service | `0x88a85f49b4d51e28eab713a436fd6112252ee0ee465e73bb01e23791d8c6a3a6` | Base (`eip155:8453`), block 48,993,708 (`0x2eb95ac`) basescan.org/tx/0x88a85f49… |
| A real paid settlement for this exact service and these exact inputs. The exhibit below was regenerated later, on a newer build, so this transaction evidences the payment rail rather than that particular envelope | `0xa07957667cf53eb52814c4c4488027da2596f109c90f8d68f323eb60eec7e4b6` | X Layer (`eip155:196`), block 66,383,878 (`0x3f4f006`), 27 July 2026 www.oklink.com/xlayer/tx/0xa0795766… The proof below was regenerated on the current build, so the settlement that paid for it moved with it. The earlier capture was paid on the Base rail (`0xedfc0322…`, still on chain); this one is on X Layer, which is the rail the audit desk uses. Both are real; only the second one pays for the artifact printed here. |
| EAS attestation schema for `risk-attest` | `0x59a8587b287d3f13776dccbe49e19d2e887f90b5e16650464b07e613d89287e0` schema string: `bytes32 merkleRoot, uint256 itemCount, string engineVersion` | Base, EAS SchemaRegistry `0x4200…0020` |
| Merkle root anchored on-chain under that schema | `0x01ffd2f9934a2c7f7df119e1e2043231fefe59be21011cb3184c956ea479a1b1` attestation `0x69d42632…`, Base, 20 July 2026, `itemCount 2` | committed under the schema above by the wallet that owns the agent identity. It batches **two** computations, not a day's worth — an earlier draft of this row described it as "a day's attestation", which overstated a two-item proof of the mechanism. It was also produced by the pre-fix tree, so it records what was anchored on that date and is not a root the current engine reproduces; re-batching the same items today gives a different one, for the reason in Section 11.5 |
| Research artifacts behind the crash study, hashed file by file | `merkleRoot 0xd376b71f94d54967325fbddc60b5d35d478884f1a70e63e0844532c24642c784` over 14 files | manifest published at `research/RESEARCH_ANCHOR.md`; recompute each file's sha256 from a clone and re-derive the root through `risk-attest`. This root supersedes two earlier ones: `0x5f9da998…`, produced by the defective tree of Section 11.5, and `0x79965fac…`, which was correct as a tree but was built over a working copy of one query file carrying a stray carriage return, so it did not reproduce from a clone — found by running the manifest's own instructions against a fresh checkout. Both are recorded in `research/RESEARCH_ANCHOR.md`. The per-file hashes of the other thirteen files never changed and are what actually pin the research. An on-chain attestation under the schema above is prepared but not yet submitted, so this establishes that the bytes are unchanged relative to a git-timestamped manifest and nothing stronger. |
| Build identity of the engine that produced every proof in this document | `q1-e1fa99d08887d6cc` | served live at `/build`; rebuildable from the public repository. Replaced `q1-bce7e7bccb16ea1b` on 26 July 2026 to close four defects (Section 11.5); the earlier build's sources remain in the repository history and still hash to it |
| Independent availability record | status page, plus the same data as JSON | `https://cgn9npwmm0.execute-api.us-east-1.amazonaws.com/` …/?format=json — hosted off this service, on AWS |


### A worked proof, end to end, from inputs a reader chooses

The following is a complete deterministic answer, captured on 27 July 2026 from the live service on build `q1-e1fa99d08887d6cc` and, separately, regenerated offline from the repository alone — the two agree byte for byte, content hash included, across a Linux container and a Windows laptop. That agreement is the exhibit rather than a footnote to it: the capture shows what the service served, and the offline regeneration shows the number is right without the service's cooperation. All four checks below were re-verified before it was printed here. It uses explicit inputs rather than a live market price, so it is re-runnable indefinitely rather than only at the moment of capture. Every field a verifier needs is *named* here; the content-hash check additionally needs the full result object, which the live response returns and this page abridges for readability.

```
{ "side": "long", "entryPrice": 64000, "size": 1, "leverage": 10, "maintMarginRate": 0.0125 }
```

```
liquidationPrice        58329.11
moveToLiquidationPct    8.861
positionStatus          ABOVE_MAINTENANCE

proof.engine            perp-gate
proof.codeHash          q1-e1fa99d08887d6cc
proof.deterministic     true
proof.inputs            {"side":"long","entryPrice":64000,"size":1,"leverage":10,"maintMarginRate":0.0125}
proof.selfChecks[0]     account_value(P_liq) == maintenance_margin(P_liq)
                        residual 2.05e-12, tolerance 0.064, pass true
proof.contentHash       8575ce5ae5bfae9cdfdfc604250f8032e4ba85fb33560386586b7538d0ab0960
proof.signature.signer  0x946324E0E5d7D77206731E35Ef4044a383e2a8C2
proof.signature         0xcabfb1954b39b306c041d546fb151582cc7d31dce403fbdaa056d7be824188fb274d2f9af2a1aa01469c2d96998c871f3a36b4ac8a6762c36f0b9d2e45c824111b
```

Four independent checks follow from that block, and they can be run in any order. One caveat first, because the exhibit was chosen for reproducibility rather than for difficulty: the self-check shown here substitutes the solved liquidation price back into the condition it was solved from, so it proves the algebra and the code path, and proves nothing about whether the maintenance-margin tier, the account-value definition, or the venue's real margin regime are the right ones. The harder self-checks in the catalogue — six finite-difference portfolio greeks in `options-risk`, the martingale residual on the recovered density, martingale-transport feasibility as an independent calendar-arbitrage certificate — carry more information and less convenience, since none of them can be recomputed by a reader with a calculator. Section 5 gives each of them in full.

1. **Does the build identity match?** `curl -s https://quiver-production-c3a8.up.railway.app/build` must report `q1-e1fa99d08887d6cc`. Cloning the public repository and hashing the engine sources must give the same string. If it does not, the code that answered is not the code that is published.
2. **Does the arithmetic hold?** The liquidation price for a long at entry 64,000 with 10× leverage and a 1.25% maintenance rate follows from equation (18): `(P₀ − M/q) / (1 − mmr)` with margin `M = 6,400`, giving `(64,000 − 6,400) / 0.9875 = 58329.11`. A reader with a calculator can confirm the served number without running anything.
3. **Does the content hash reproduce?** `sha256` over the key-sorted canonical JSON of `{engine, codeHash, inputs, result}`, where `result` is the response with its `proof` key removed, must equal `8575ce5ae5bfae9cdfdfc604250f8032e4ba85fb33560386586b7538d0ab0960`. The response carries its own recipe for this in `proof.verifyContentHash`, and the SDK exposes it as `verify()`.
4. **Does the signature recover?** `ethers.verifyMessage(contentHash, signature)`, where `contentHash` is passed as the 64-character lowercase hex string exactly as printed above (no `0x` prefix, hashed under EIP-191 as UTF-8 text), must return `0x946324E0E5d7D77206731E35Ef4044a383e2a8C2`, the same signer published in the agent card at `/.well-known/agent-card.json`. This is the step that ties the number to an identity rather than merely to a hash.

An unpaid request to `POST /api/perp-gate` answers with the x402 `402` challenge, so the shape of the payment surface costs nothing to inspect. All four checks then run **offline, from the repository and this page alone** — no live call and no payment. The reason is that `proof.inputs` is printed above in full and the engine is open source, so the result object is not merely *received*: it can be *regenerated*. Re-running the published `perp-gate` engine on those five inputs and sealing it exactly as the service does reproduces this exhibit in every digit — liquidation price 58329.11, self-check residual 2.05e-12, and the content hash above byte-for-byte. That reproduction is itself locked by a test in the suite, so an engine change that stales this appendix fails the build rather than quietly misleading a reader. A paid call proves that the service *served* it; the repository proves that it is *right*. Neither requires the other, and at this service's price the paid confirmation is one cent.

One claim deserves singling out, because it is the one a sceptical reader should press hardest. The crash study's out-of-sample status rests on thresholds having been fixed before the 2026 events were examined. The evidence for that is narrower than an anchored log would be: the thresholds are literal constants in the published query files, the calibration set contains only 2025 episodes, and the repository's commit history shows the order the files appeared in. All three of those are under our control. We did not anchor a hash of them before running the tests, which is what would settle it, and an anchor made now cannot back-date itself. The manifest above freezes them from this point forward; it does not vouch for what came before it. A reader who discounts the out-of-sample claim on that basis is reasoning correctly.

What this appendix does not do is make the unverifiable parts verifiable. The population-scale crash replay, the test suite, the availability record and the buyer audit are still assertions backed by scripts in the repository rather than by anything a reader can check in a browser; the honest way to read them is as claims from a source that has, in the artifacts above, given the reader the means to catch it lying about the parts that can be checked.


## References

Every entry below is cited in the text and carries part of the argument. An earlier draft listed a further twenty-nine background sources that nothing in the document depended on, under a note telling the reader to ignore them — a bibliography a third of which its own author disclaims is decoration, so it was removed rather than defended. Three entries also carried citation markers inside their own titles, an artefact of an earlier edit; a reference cannot cite itself, and those are gone too.

1. F. Black, "The pricing of commodity contracts," *Journal of Financial Economics*, vol. 3, no. 1–2, pp. 167–179, 1976.
2. F. Black and M. Scholes, "The pricing of options and corporate liabilities," *Journal of Political Economy*, vol. 81, no. 3, pp. 637–654, 1973.
3. R. C. Merton, "Theory of rational option pricing," *The Bell Journal of Economics and Management Science*, vol. 4, no. 1, pp. 141–183, 1973.
4. D. T. Breeden and R. H. Litzenberger, "Prices of state-contingent claims implicit in option prices," *The Journal of Business*, vol. 51, no. 4, pp. 621–651, 1978.
5. J. Gatheral, "A parsimonious arbitrage-free implied volatility parameterization with application to the valuation of volatility derivatives," presentation, Global Derivatives & Risk Management, Madrid, 2004.
6. J. Gatheral and A. Jacquier, "Arbitrage-free SVI volatility surfaces," *Quantitative Finance*, vol. 14, no. 1, pp. 59–71, 2014. arXiv:1204.0646.
7. J. Gatheral, *The Volatility Surface: A Practitioner's Guide*. Hoboken, NJ: Wiley, 2006.
8. R. W. Lee, "The moment formula for implied volatility at extreme strikes," *Mathematical Finance*, vol. 14, no. 3, pp. 469–480, 2004.
9. A. Castagna and F. Mercurio, "The vanna-volga method for implied volatilities," *Risk*, vol. 20, no. 1, pp. 106–111, 2007.
10. A. S. Kyle, "Continuous auctions and insider trading," *Econometrica*, vol. 53, no. 6, pp. 1315–1335, 1985.
11. Y. Amihud, "Illiquidity and stock returns: cross-section and time-series effects," *Journal of Financial Markets*, vol. 5, no. 1, pp. 31–56, 2002.
12. D. Easley, M. M. López de Prado, and M. O'Hara, "Flow toxicity and liquidity in a high-frequency world," *The Review of Financial Studies*, vol. 25, no. 5, pp. 1457–1493, 2012.
13. R. Almgren and N. Chriss, "Optimal execution of portfolio transactions," *Journal of Risk*, vol. 3, no. 2, pp. 5–39, 2000.
14. C. M. C. Lee and M. J. Ready, "Inferring trade direction from intraday data," *The Journal of Finance*, vol. 46, no. 2, pp. 733–746, 1991.
15. R. Almgren, C. Thum, E. Hauptmann, and H. Li, "Direct estimation of equity market impact," *Risk*, vol. 18, no. 7, pp. 58–62, 2005.
16. G. Bakshi and N. Kapadia, "Delta-hedged gains and the negative market volatility risk premium," *The Review of Financial Studies*, vol. 16, no. 2, pp. 527–566, 2003.
17. P. Carr and L. Wu, "Variance risk premiums," *The Review of Financial Studies*, vol. 22, no. 3, pp. 1311–1341, 2009.
18. T. Bollerslev, G. Tauchen, and H. Zhou, "Expected stock returns and variance risk premia," *The Review of Financial Studies*, vol. 22, no. 11, pp. 4463–4492, 2009.
19. C. Acerbi and D. Tasche, "On the coherence of expected shortfall," *Journal of Banking & Finance*, vol. 26, no. 7, pp. 1487–1503, 2002.
20. "EIP-712: Typed structured data hashing and signing," Ethereum Improvement Proposals, no. 712, 2017. [Online]. Available: https://eips.ethereum.org/EIPS/eip-712
21. "EIP-2612: Permit — 712-signed approvals," Ethereum Improvement Proposals, no. 2612, 2020. [Online]. Available: https://eips.ethereum.org/EIPS/eip-2612
22. "EIP-1967: Proxy Storage Slots," Ethereum Improvement Proposals, no. 1967, 2019. [Online]. Available: https://eips.ethereum.org/EIPS/eip-1967
23. "EIP-7702: Set EOA account code," Ethereum Improvement Proposals, no. 7702, 2024. [Online]. Available: https://eips.ethereum.org/EIPS/eip-7702
24. "EIP-3009: Transfer With Authorization," Ethereum Improvement Proposals, no. 3009, 2020. [Online]. Available: https://eips.ethereum.org/EIPS/eip-3009
25. Uniswap Labs, "Permit2," 2022. [Online]. Available: https://github.com/Uniswap/permit2
26. M. De Rossi, D. Crapis, J. Ellis, and E. Reppel, "ERC-8004: Trustless Agents," Ethereum Improvement Proposals, no. 8004, 2025. [Online]. Available: https://eips.ethereum.org/EIPS/eip-8004
27. Coinbase, "x402: A payments protocol for the internet — Specification v2," 2025. [Online]. Available: https://github.com/coinbase/x402
28. Google, "Agent2Agent (A2A) Protocol Specification," 2025. [Online]. Available: https://a2a-protocol.org
29. Anthropic, "Model Context Protocol (MCP) Specification," 2024. [Online]. Available: https://modelcontextprotocol.io
30. J. A. Nelder and R. Mead, "A simplex method for function minimization," *The Computer Journal*, vol. 7, no. 4, pp. 308–313, 1965.
31. M. Abramowitz and I. A. Stegun, *Handbook of Mathematical Functions*, formula 7.1.26. Washington, DC: National Bureau of Standards, 1964.
32. Apache Software Foundation, "Apache ECharts." [Online]. Available: https://echarts.apache.org
33. "technicalindicators (npm package), v3.1.0." [Online]. Available: https://www.npmjs.com/package/technicalindicators
34. OpenJS Foundation, "node:test — the built-in Node.js test runner." [Online]. Available: https://nodejs.org/api/test.html
35. ScamSniffer, "Web3 Scam Report: Wallet Drainers," 2024. [Online]. Available: https://scamsniffer.io
36. S. Figlewski, "Estimating the implied risk-neutral density for the U.S. market portfolio," in *Volatility and Time Series Econometrics*, T. Bollerslev, J. Russell, and M. Watson, Eds. Oxford: Oxford University Press, 2010.
37. A. M. Malz, "Estimating the probability distribution of the future exchange rate from option prices," *The Journal of Derivatives*, vol. 5, no. 2, pp. 18–36, 1997.
38. G. J. Jiang and Y. S. Tian, "The model-free implied volatility and its information content," *The Review of Financial Studies*, vol. 18, no. 4, pp. 1305–1342, 2005.
39. M. Beiglböck, P. Henry-Labordère and F. Penkner, "Model-independent bounds for option prices — a mass transport approach," *Finance and Stochastics*, vol. 17, no. 3, pp. 477–501, 2013.
40. Coinbase, x402 adoption reporting, April 2026: 69,000 active agents and 165M transactions.
41. x402 first-year totals: 169M+ payments across 590,000 buyers and 100,000 sellers, reported at the protocol's one-year mark, 2026.
42. M. Zhang et al., "FAITH: a framework for assessing intrinsic tabular hallucinations in finance," arXiv:2508.05201, 2025.
43. Nof1, "Alpha Arena" season 1, 18 October – 3 November 2025: six frontier models each trading $10,000 of perpetuals autonomously on Hyperliquid. Final standings: Qwen3-Max +22.3%, DeepSeek V3.1 +4.9%, Claude Sonnet 4.5 and Gemini 2.5 Pro each down more than 40%, Grok 4 about −58%, GPT-5 last at −62.66%. Four of six ended in the red; one passed −60%.
44. J. Milionis, C. C. Moallemi, T. Roughgarden and A. L. Zhang, "Automated market making and loss-versus-rebalancing," arXiv:2208.06046, 2022.

Quiver technical documentation, version 1.0, July 2026. Prepared for the OKX AI Genesis Hackathon. All quantitative figures were captured from live venues during validation and are representative of the methods described; live values vary with market state. This document is technical documentation and not financial advice.

---

**End of the document.** Part 6 of 6 was the last.
