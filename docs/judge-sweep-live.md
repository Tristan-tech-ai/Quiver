# Judge sweep — live system, adversarial

**Target:** `https://quiver-production-c3a8.up.railway.app`
**Date of sweep:** 29 July 2026
**Build under test:** `/build` → `codeHash q1-e1fa99d08887d6cc`, node v24.10.0, version 0.1.0
**Method:** ~230 live calls. Free MCP path (`POST /mcp`) for the 9 tools it exposes; the unpaid
engine path (`/diag/scanpost`, gated by the repo's own `DIAG_TOKEN`, which runs the same
`validate()` + `run()` a paying caller reaches) for all 22. No payment was made and no key was used,
so the x402 wrapper itself was read from source rather than exercised — every claim that depends on
it is labelled below.

---

## Verdict

**Three stars, and it should be four.** The verifiability apparatus is real and it holds up under
direct attack: the published `codeHash` recomputes from a clean-room reimplementation of its own
published rule, Appendix C reproduces byte for byte including its signature, four services re-run
from their own echoed inputs to identical content hashes, and a served Plonk proof verifies against
the served verification key and is rejected when one public signal is moved by one unit. I tried to
break those and could not. The refusal machinery the last review complained about is now genuinely
good — 36 of 36 bad calls came back with a corrected body, and none fired on a correct call.

It is not four stars because of one defect, and the defect is in exactly the place this project
cannot afford one.

### The single strongest reason against Quiver

**`side` and option `type` are matched as exact lowercase strings, and anything else fails open to
the riskier default — silently, with every self-check passing and the answer signed.**

A perfectly hedged book, live, over the free MCP endpoint:

```
positions: [ {asset BTC, side "long",  size 1, entryPrice 100000, markPrice 100000, leverage 10, mmr 0.0125},
             {asset BTC, side "short", size 1, entryPrice 100000, markPrice 100000, leverage 10, mmr 0.0125} ]
→ netExposureByAsset[BTC].netNotional = 0            allSelfChecksPass: true
```

Capitalise one word:

```
             {asset BTC, side "SHORT", ...}
→ netExposureByAsset[BTC].netNotional = 200000       allSelfChecksPass: true
   proof.inputs echoes side "SHORT"; the served leg reads side "long"
   contentHash 6866d34fde0308f13e5ca321…, signed by 0x9463…a8C2
```

A flat book is reported as a fully doubled-up directional bet. The same substitution on
`perp_gate`: `side:"SHORT"` returns liquidation **91,139.24** (the long's) instead of
**108,641.98** — it tells a short seller they liquidate on the way *down*. `"Short"`, `"SELL"`,
`"s"`, `""`, `null` and `"buy"` all become **long**; only the literal `"short"` and `"sell"` are
read as short.

`options_risk` has the same shape on a more expensive field. Every value that is not the literal
string `"put"` is priced as a **call**:

| sent `type` | served as | portfolioValue | delta |
| --- | --- | --- | --- |
| `"call"` | call | 3,270.26 | +0.320 |
| `"put"` | put | 13,270.26 | −0.680 |
| `"PUT"` | **call** | 3,270.26 | **+0.320** |
| `"Put"`, `"P"`, `"p"`, `"puts"`, `" put"`, `"banana"`, `null`, `""`, `123` | **call** | 3,270.26 | +0.320 |

All six finite-difference greek checks pass in every row, because they verify that the greeks are
consistent with the book the engine *chose*, not with the book the caller *described*.

Root cause, both in `src/engine/` (read only, not modified):

- `src/engine/perpGate.js:29` — `const sideSign = (s) => (s === 'short' || s === 'sell' || s === -1 || s === '-1' ? -1 : 1);`
- `src/engine/optionsRisk.js:32` — `const type = p.type === 'put' ? 'put' : 'call';`

Why the safety net does not catch it. `src/util/repair.js` step 6 *does* case-correct enum values —
but only where the service's own `inputSchema` declares an `enum`. `src/services.js:276` declares
perp-gate's side as `{ type:'string', description:'long | short' }` with **no `enum` array**, so the
recase never fires. Meanwhile `src/mcp.js:76` advertises `side: { enum: ['long','short'] }` to every
MCP client — `handleRpc` repairs against the SERVICES entry, not the TOOLS entry, so the enum the
server publishes is decorative and unenforced. `repairBody` also does not descend into array items,
which is where option `type` and portfolio `side` both live.

Three consequences a reviewer will draw:

1. **The proof is self-consistently wrong.** `proof.inputs` faithfully echoes `"SHORT"`, and
   re-running the open engine on those inputs reproduces the answer exactly — because the engine
   repeats the substitution. Re-runnability certifies the pipeline, not the interpretation. This is
   the sharpest limit on the whole thesis and the paper does not state it.
2. **It is billable.** Derived from `src/x402.js` `isChargeable()` — not live-observed, since no
   payment was made: the rule returns `false` only for `ok === false` or a failed check. Here
   `ok:true` and every check passes, so the caller is charged for the inverted answer.
3. **It is one word to fix**, in a file I was told to stay out of: add `enum: ['long','short']` to
   the side property in `services.js`, `enum: ['call','put']` to the option-type item property,
   extend `repairBody` into array items, and make the engines refuse an unrecognised value instead of
   defaulting. The engines' fail-open default is the part that needs an owner's decision.

---

## The MCP-versus-HTTP asymmetry

The brief asked whether `/mcp` is a metered free tier or an open side door. **Neither framing
survives contact with the code, because the premise is wrong.**

**Established, by measurement:**

- `/mcp` exposes **9 tools**, not 22. `tools/list` returns exactly `perp_gate, portfolio_gate,
  size_gate, exec_verify, options_risk, lp_risk, treasury_risk, risk_attest, event_vol`. The other
  13 are HTTP-only. `tape_pulse` over MCP returns `unknown tool` with the full available list.
- `POST /mcp` is reachable **directly and unauthenticated**. `initialize` and `tools/call` both
  answer to a plain curl with no credential, no OKX involvement, and CORS `*`. There is no upstream
  gateway in the path: the metering is Quiver's own, in `src/app.js` — an in-process
  `Map` keyed by IP, `MCP_DAILY_CALLS` default 300, tool calls only, `initialize`/`tools/list`
  unmetered. I made ~180 tool calls without hitting it, consistent with a limit ≥ 180.
- All 22 `/api/*` routes return **402** to an unpaid POST, with both rails (X Layer USD₮0,
  Base USDC) and the full input schema in `accepts[].outputSchema.input.body`. The gate fires before
  validation, as documented.
- For the 9 engines on both paths, **the free answer is the paid answer.** The Appendix C inputs
  over free MCP return contentHash `8575ce5a…` and signature `0xcabfb195…` — byte-identical to the
  paper's exhibit, which was paid for. So for those 9, payment buys quota, not capability.

**Established, from source and documentation:**

- This is deliberate and published, not a leak. `assets/whitepaper.part6.md:95` states it outright:
  "the nine deterministic risk engines are also reachable free over the MCP endpoint, under a
  fair-use daily quota… a deliberate distribution choice… and not an oversight". `part7.md:107`
  gives the 300/day/IP figure and the `-32000` overflow error. `/llms.txt` says "Free tier: POST
  /mcp (Streamable HTTP MCP, 9 risk tools…)". The paper is straight about this.

**Unestablished — do not read as findings:**

- Whether OKX's A2MCP registration for agent #5152 lists all 22 services as MCP-callable. I could
  not read the registry from here. If it does, 13 of those listings point at tools `/mcp` does not
  expose. Worth checking before judging.
- Whether OKX proxies or meters anything upstream. I saw no evidence either way; I only established
  that the origin is directly reachable without it.
- Any claim about paid-path behaviour that requires an actual settlement.

**Weaknesses of the metering worth naming:** the quota Map is per-process and in-memory, so it
resets on every redeploy and is not shared between replicas; it is keyed on `req.ip` behind
`trust proxy: true`, so rotating IPs bypasses it. That is a revenue-integrity question, not a
security hole — the endpoint is read-only compute with nothing to protect.

---

## All 22 services

`answers` = HTTP 200 with a usable body on a realistic input. `checks` = self-checks in the envelope.
`teaches` = the refusal on a bad body names what is wrong and hands back a corrected body.

| # | service | on MCP | answers | envelope | checks | provenance disclosed | teaches | notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | tape-pulse | no | yes | observation | 0 | `observedAtUtc` + `semantics` | yes | 500 on chain/address mismatch |
| 2 | chart-press | no | yes | observation | 0 | yes | yes | silently accepts bad `interval`, out-of-range `lookback` |
| 3 | poly-fill | no | **NO (500)** | none | 0 | n/a | partial | nonexistent market → `engine_error` |
| 4 | poly-desk | no | yes | observation | 0 | yes | yes | clean empty-book handling |
| 5 | options-desk | no | yes | observation | 0 | yes | **exemplary** | refusal names the right sibling service |
| 6 | lp-desk | no | yes | observation | 0 | yes | yes | bad pool → `ok:false` with a real diagnosis |
| 7 | calldata-x | no | yes | observation | 0 | yes | yes | names 4byte as its source; see minor findings |
| 8 | protocol-pulse | no | yes | observation | 0 | yes | yes | `NOT_FOUND` verdict, not an error |
| 9 | macro-sentry | no | yes | observation | **1/1** | yes | partial | accepts negative `hours` |
| 10 | updown-pulse | no | yes | observation | 0 | yes | **exemplary** | |
| 11 | loop-digest | no | yes | observation | 0 | yes | yes | bogus cursor → explicit `unknown-rebaselined` |
| 12 | token-scan | no | yes | observation | 0 | yes | yes | `INSUFFICIENT_DATA`, honest |
| 13 | wallet-audit | no | yes | observation | 0 | yes | yes | schema + refusal call the field "token contract address" |
| 14 | perp-gate | yes | yes | proof | 1/1 | deterministic | yes | **side coercion**; symbol-mode → observation, correct |
| 15 | portfolio-gate | yes | yes | proof | 7/7 | **see finding 2** | yes | **side coercion**; `account` mode **crashes** |
| 16 | size-gate | yes | yes | proof | 4/4 | deterministic | yes | clean |
| 17 | exec-verify | yes | yes | proof | 2/2 | deterministic | yes | bounds `feeTier` to `[0,1)` — good |
| 18 | options-risk | yes | yes | proof | 6/6 | deterministic | yes | **type coercion** |
| 19 | lp-risk | yes | yes | proof | 5/5 | deterministic | yes | self-check catches a unit error — good |
| 20 | treasury-risk | yes | yes | proof | 5/5 | deterministic | yes | no bound on `depegProbAnnual` |
| 21 | risk-attest | yes | yes | proof | 4/4 | deterministic | **exemplary** | short-hex refusal explains the old collision bug |
| 22 | event-vol | yes | yes | proof | 1/1 | deterministic | yes | self-check catches a unit error — good |

**21 of 22 answered well.** One (`poly-fill`) returned HTTP 500 on a realistic first attempt.

The observation/proof split is the honest half of the design and it is honest: every one of the 13
live-data services ships `kind: OBSERVATION`, `deterministic: false`, `observedAtUtc`, and a
`semantics` block that says in plain words the number is not re-runnable. But **12 of those 13 ship
`selfChecks: []` and `allSelfChecksPass: null`**, so `/llms.txt`'s "every answer carries a
re-runnable, self-checked proof" is true of 9 services out of 22. The envelopes do not lie; the
front-page copy overreaches.

---

## Mistake paths that still produce a bad experience

Refusals are strong. Across 63 MCP calls: **36 of 36 refusals carried a `howToFix` corrected body**,
`routingNotice` fired on **7 of 9** wrong-service bodies naming the right tool and price, and
**neither fired on a single one of the 10 correct calls.** The `routingNotice`/`howToFix` pair works
and is disciplined. On the HTTP side, `refusalDetail` + `redirectLine` are equally good — `options-desk`
refuses a missing currency with "it cannot answer a protocol health question at any price… the call
you want is: POST /api/protocol-pulse with {"protocol":"aave"}. This refusal is free — you were not
charged." That is the standard.

The problem is the opposite of a refusal. **13 of 15 unit-scale mistakes were answered, not
refused**, and only 2 were caught by a self-check.

### Serious — answered, wrong, and endorsed

| # | call | result | disclosed? |
| --- | --- | --- | --- |
| 1 | `perp_gate {side:"SHORT"}` / `portfolio_gate` leg `side:"SHORT"` | priced as **long** | no — checks pass |
| 2 | `options_risk {type:"PUT"}` | priced as **call**, delta sign flips | no — 6/6 checks pass |
| 3 | `perp_gate {leverage:0.1}` | `liquidationPrice: -911392.41`, `moveToLiquidationPct: 1011.392`, `positionStatus: ABOVE_MAINTENANCE` | no — check passes. A long cannot need a >100% adverse move; a negative liquidation price means "unliquidatable", and the service prints it as a price |
| 4 | `treasury_risk {depegProbAnnual: 50}` | `expectedAnnualDepegLossUsd: 25,000,000` on a **$5,000,000** book, `riskAdjustedApyPct: -496` | no — 5/5 checks pass. An expected loss 5× the treasury is impossible |
| 5 | `exec_verify {feeTier: 0.3}` | `adverseExecutionBps: -4028.88`, verdict "**BETTER** than the honest pool price (favorable)" | no — checks pass. The same fill at the correct 0.003 reads −149.65 bps *adverse*. A fat-fingered fee inverts a sandwich verdict into a compliment |
| 6 | `options_risk {iv: 60}` | gamma, vega, theta, vanna, volga all exactly **0** on a 30-day option | no — 6/6 checks pass |

### Broken outright

| # | call | result |
| --- | --- | --- |
| 7 | `portfolio_gate {account:"0x31ca…974b"}` | `error: fetchHlAccount is not defined` — a live **ReferenceError**. `src/mcp.js:169` calls it; `src/mcp.js:27` imports only `enrichPerpInputs, enrichPortfolioLegs`. `services.js:32` imports it correctly, so the HTTP path works and the free MCP path does not. This is the *headline* feature in the tool's own description ("OR just account: a Hyperliquid 0x address, whose FULL live book… is pulled keylessly") and it is the exact call a judge is most likely to try. **Fix: add `fetchHlAccount` to the import on line 27.** |
| 8 | `poly-fill` with a plausible-but-nonexistent market slug | HTTP **500 `engine_error`**, detail "no active Polymarket market matched…". It is a caller-input problem reported as a server fault |
| 9 | `tape-pulse {chain:"solana", address:"0xc02a…"}` (and the reverse) | HTTP **500**, detail `okx GET /api/v6/dex/market/trades -> 400 {"code":"51000",…}` — a raw upstream error leaked to the caller. Reads as "the service is down" |

### Finding 2 — a proof envelope over an undisclosed live venue read

`portfolio_gate` with explicit positions carrying `venue:"hyperliquid"` silently fetches the live
mark and injects it into the result. Sent: `{venue:"hyperliquid", asset:"BTC", size:1,
entryPrice:100000, leverage:10, maxLeverage:40}`. Returned: `proof.inputs` contains
`markPrice: 63826` — a field never supplied — inside an envelope marked `deterministic: true`, with
**no `observedAtUtc`, no `live` block and no `mathReproducibility` note.** The content hash still
reproduces, because the fetched value is frozen into `inputs`; but a reader comparing their request
to `proof.inputs` finds a number they never sent, with no source and no timestamp.

This is the same defect §11.5 of the paper records finding and fixing on `perp-gate` symbol mode —
which now correctly returns an observation. `portfolio_gate` was not given the same treatment on the
explicit-positions path. Practical effect: the textbook example above comes back
`positionStatus: BELOW_MAINTENANCE` and `nearestLiquidation: null`, i.e. the tool's headline output
is null and the judge is told their hypothetical book is already liquidated. The per-leg
`statusNote` explains it well; nothing at the top level does.

### Minor

- `chart-press` accepts `interval:"7H"` and `lookback:99999` with HTTP 200 and no report of what it
  actually used. `repairBody` reports every repair it makes; this normalisation is not one of them.
- `macro-sentry {hours:-72}` returns `verdict:"CLEAR"` and the prose "No high-impact US macro events
  in the next -72h" while an FOMC sits 16h away.
- `wallet-audit`'s published schema and its own refusal text both describe `address` as
  "token contract address". It is a wallet address. The defect is inside the teaching output.
- `calldata-x` on `0xdeadbeef` returns `verdict:"DECODED"`, `function:"CodeIsLawZ95677371()"`,
  `alert.level:"INFO"`. It does name its source ("the public 4byte signature registry") in
  `provenance`, which is the right instinct; it does not say that registry is collision-prone or
  whether there were other candidates. On a security service, a confident decode of a junk selector
  deserves a caveat.
- `treasury_risk` has no bound on `depegProbAnnual`; `event_vol` has none on `atmIv`;
  `size_gate` none on `volatility`. `exec_verify` bounds `feeTier` to `[0,1)` and refuses cleanly —
  it is the model the others should follow.
- MCP `size_gate` omits `drawdownLevels`, which the HTTP schema declares. Harmless drift.

---

## Published claims — what held

| claim | verdict | evidence |
| --- | --- | --- |
| `/build` publishes a codeHash **and the rule that produced it** | **HOLDS** | Clean-room reimplementation of the published rule (recursive walk of `src/engine`, `` `${rel}:${utf8}` ``, `\n` join, `'q1-'+sha256.hex[0:16]`) over both repo copies → `q1-e1fa99d08887d6cc`, and the 37-file manifest matches the served list exactly, in order. Neither copy of my recomputation imported repo code. |
| **Appendix C reproduces byte for byte** | **HOLDS, fully** | Offline from the repo: liquidationPrice `58329.11`, moveToLiquidationPct `8.861`, `ABOVE_MAINTENANCE`, `deterministic: true`, self-check residual `2.05e-12` against tolerance `0.064`, contentHash `8575ce5ae5bfae9cdfdfc604250f8032e4ba85fb33560386586b7538d0ab0960` — all identical to the printed exhibit. Live over free MCP: same numbers, **and the signature is byte-identical** to the one printed (`0xcabfb195…c824111b`). `ethers.verifyMessage(contentHash, signature)` → `0x946324E0E5d7D77206731E35Ef4044a383e2a8C2`, the signer published in `/.well-known/agent-card.json`. All four of the appendix's own checks pass. |
| `/proof/vk` serves a vk a served proof verifies against | **HOLDS** | `{"snark":true}` on perp-gate left the contentHash unchanged (`8575ce5a…`, so the flag is correctly stripped before hashing), proof ready in ~3 s. `snarkjs.plonk.verify(servedVk, servedSignals, servedProof)` → **true**. Moving `publicSignals[7]` (the certified liquidation price) by one unit → **false**. vk is plonk/bn128, nPublic 8, power 11. `signalsAttestation` present and signed by the same key. |
| "Every answer is re-runnable" | **HOLDS for the 9 deterministic services** | `perp_gate`, `size_gate`, `options_risk`, `treasury_risk` all re-run from their own `proof.inputs` through the open repo engine to **identical content hashes**, and `proof.inputs` equalled what I sent in all four. It does **not** hold for the other 13, which say so themselves. |
| `/paper/1`…`/paper/7` match the repo | **HOLDS** | All seven parts sha256-identical to `assets/whitepaper.part[1-7].md`. `/paper/full` 253 kB; a request for a part beyond the last one 404s correctly and names the part count. |
| Unpaid `/api/*` returns 402 on all 22 | **HOLDS** | All 22 probed; all 402 with both rails and the full input schema. |
| `routingNotice` / `howToFix` fire where they should and stay silent otherwise | **HOLDS** | 36/36 refusals carried `howToFix`; 7/9 misroutes carried `routingNotice`; 0/10 correct calls carried either. |
| `npm test` at 386 | **HOLDS** | `pass 381, fail 0, skipped 5` = 386 total. Unchanged; nothing added. |
| `node tools/docs-consistency.mjs` | **HOLDS** | `CONSISTENT — 120 documents agree with each other and with the running system.` The gate is not a rubber stamp: it caught a false claim in the first draft of *this* report and named the line. |

## Published claims — what did not

1. **The changelog served live is not the changelog in the repo.** `/changelog` is 9,827 bytes; the
   repo's is 12,722. The repo carries a 29 July entry (the S3-backed durable proof store) that the
   live service does not serve, and live `/build.proofStorage.note` still says only
   "Set `QUIVER_PROOF_DIR`" where the repo's `app.js` says "`QUIVER_PROOF_S3_BUCKET`… or
   `QUIVER_PROOF_DIR`". The changelog exists so a reviewer can tell an improvement from a
   discrepancy, and it is the artifact that has diverged.

2. **This is also the cleanest available demonstration of the codeHash's scope limit.** The deployed
   `app.js` provably differs from the repo's, and `codeHash` matched anyway — because it covers
   `src/engine/` only. The envelope says so (`codeHashScope`), but a judge should read it plainly:
   the build hash certifies the *mathematics*, and certifies nothing about the validation, the
   refusals, the adapters that fetch live data, the payment wrapper, or the MCP layer — which is
   where every defect in this report lives. That gap deserves a sentence in the paper it does not
   currently have.

3. **The test count is overstated by five, in two places.** `part1.md`: "386 tests that run on every
   build, with a further five live-archive integration tests that are SKIPPED"; `part4.md` §6.1:
   "386 automated tests… alongside a further five". The five skipped are *inside* the 386, not
   additional: the runner reports 381 pass + 5 skipped. §11.6 gets it right ("later rounds have taken
   it to 386 and 381"), so the document contradicts itself. The same `part1` sentence also says
   "None of the **333** fails" — a stale count from an earlier round; it should read 381. Ironic,
   because that sentence is itself a correction of a previous miscount.

4. **"Each answer carries a re-runnable, self-checked proof."** Served at `/`, `/llms.txt` and the
   agent card. True of 9 services; 12 of the other 13 ship `selfChecks: []` and
   `allSelfChecksPass: null`. The per-response envelopes are scrupulous about this; the front-page
   copy is not.

---

## What could not be broken

Stated plainly, because it is the larger half of the picture. I could not:

- produce a codeHash mismatch, or a file-manifest mismatch, from either repo copy;
- make a content hash fail to reproduce on any deterministic service, including with `snark:true`;
- make the Appendix C exhibit differ from the live answer in any digit, including its signature;
- get the Plonk verifier to accept a tampered public signal, or `/proof/vk` to serve a key the
  served proof did not verify under;
- get `routingNotice` or `howToFix` to fire on a correct call, or to fail to fire on a wrong one;
- get an unpaid `/api/*` request to return anything but 402;
- find a single failing test or a docs-consistency failure.

The refusal experience the previous review complained about is fixed. **The exposure now runs the
other way: inputs that should be refused are silently normalised into a different question, and the
proof machinery signs the answer to that different question.** That is the finding, and it is worth
more than the one it replaced.

---

## Ranked fixes

1. `src/mcp.js:27` — import `fetchHlAccount`. One line; restores the advertised headline feature.
2. `src/services.js` — declare `enum: ['long','short']` on `side` and `enum: ['call','put']` on the
   option-type item; extend `repairBody` into array items so nested enums are recased and *reported*.
3. `src/engine/perpGate.js:29` and `optionsRisk.js:32` — refuse an unrecognised `side`/`type` rather
   than defaulting. Owner's call, since it is inside the hashed tree and changes the build hash.
4. `portfolio-gate`: return an observation envelope with `observedAtUtc` whenever a leg's mark was
   fetched, exactly as `perp-gate` symbol mode now does.
5. Convert the two `500 engine_error` paths (`poly-fill` no-match, `tape-pulse` chain/address
   mismatch) into 400s with a `howToFix`, and stop echoing raw upstream error strings.
6. Redeploy so `/changelog` matches the repo; fix the 386/381/333 arithmetic in `part1` and `part4`;
   soften the "every answer" copy on `/` and `/llms.txt` to name the 9.
7. Bound `depegProbAnnual`, `atmIv`, `volatility` and `leverage` the way `exec_verify` bounds
   `feeTier`, or add a plausibility check that fails loudly.
