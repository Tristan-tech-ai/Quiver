# Quiver — what changed, and when

The hackathon submission describes this service as it stood at the moment it was written. Judging
runs afterwards and the service keeps improving, so this page exists to close the gap the other
direction: everything below is dated, and anything the submission claims should be *at least* as true
now as it was then.

Two things will not change while judging runs, because a reviewer testing a moving target learns
nothing: the endpoint URL, and the engine build hash `q1-e1fa99d08887d6cc` that every published proof
quotes. The worked proof in Appendix C of the paper reproduces byte-for-byte against this build, and
that is the contract with anyone checking our claims.

---

## 1 August 2026 (later still) — closing two ways this could have been delisted again

Neither of these was reported by a caller. Both came out of reading OKX's own requirements against the
service after it was relisted, which is a thing worth doing while nothing is on fire.

**The rate limiter was shaped to fail a review.** One global bucket, 60 requests per minute per IP,
applied ahead of everything, including the 402 challenge itself. A reviewer probing twenty-two services
on two verbs issues forty-four requests before they have looked at the index, the agent card or the
paper, and past sixty they stop receiving a payment challenge and start receiving `429`. **A 429 is not
a 402**, and to an automated compliance check it reads as a service that does not answer. This is not a
hypothesis: this project's own gate tripped it earlier the same day at sixty-six requests.

The number was never the problem. Treating every request as equally expensive was. An unpaid request
cannot reach an engine; it reads configuration and returns a challenge. So the limiter now has two
buckets: **600 a minute for anything that cannot run an engine** (the challenge, the public pages, the
agent card, stored proofs, `/build`) and the original **60 for everything that does** (paid calls,
`/mcp`, and the `/diag` probes). Separate counters, so a burst of free challenges cannot eat the
allowance a paying caller needs. A paid call is in any case self-limiting, because it costs the caller
money.

**And x402 v1 clients had quietly lost the ability to pay.** The hand-rolled gate this service ran until
this morning read `PAYMENT-SIGNATURE` or `X-PAYMENT`. The official SDK reads only the first. So the
migration, which fixed one compatibility problem, introduced another: a v1 client presents a perfectly
valid payment, the gate never sees it, and it receives a 402 for ever. The v1 header is now copied
across before the gate runs, which restores exactly what this service accepted before and changes
nothing for a client already sending the v2 name.

Both are locked in `gates/gateSDK-x402.mjs`. The burst check is the only one in that file that is
deliberately unpaced, since being unthrottled is the whole claim, and it was verified in the direction
that matters: forcing the cheap limit down to ten made eighty of ninety requests come back 429, so the
check can fail. The v1 alias is asserted to reach the same refusal as the v2 name offline, and proven
with a real payment against the live service.

Nothing here moves `q1-e1fa99d08887d6cc`, the endpoint, the service list or any price.

## 7 August 2026 — the paper caught three things the SDK migration had quietly taken away

**This entry exists because the whitepaper was audited against the live endpoint, and the endpoint lost.**
Section 4 prints a block captioned *"what `POST /api/perp-gate` answers with today"*. It was accurate when
it was written on 29 July. By 7 August three of its fields were gone, removed not by a decision but as a
side effect of moving the payment layer onto the official OKX SDK.

**What had disappeared, and why each one matters to somebody:**

· `maxAmountRequired` is where an **x402 v1 client looks for the price**. Version 2 renamed the field to
`amount`; a client written against v1 reads our challenge and finds no price in it at all.
· `decimals` at the entry level lets a caller size the payment without first resolving the token. USD₮0
is exactly the asset a generic resolver gets wrong, which is the reason we self-describe it.
· `outputSchema` is the **x402 Bazaar discovery extension**: it tells a caller how to shape the body on
the paid retry. Without it a discovery client can find this endpoint and still not know how to call it.

**And one thing that had gone quiet rather than missing.** The old gate read
`PAYMENT-SIGNATURE || X-PAYMENT`. The SDK reads only the first, so every v1 client that presents a
perfectly valid payment under the older header name had been getting a 402 forever, with nothing in the
response to say why. That is the worst shape a regression can take: correct-looking, silent, and only
visible to the party it hurts.

**All four are restored, and the restoration is one function.** `enrichEntry` puts the three fields back,
and it is applied to the body mirror, to the offline fallback, and to the PAYMENT-REQUIRED header the SDK
writes, by wrapping `res.setHeader`. One function for all three surfaces is deliberate: the gate asserts
the header and the body are identical, so enriching them separately would be a divergence waiting for a
quiet afternoon. The EIP-712 domain is untouched, which the gate also checks, because nothing about a
compatibility field is worth risking the thing that makes a signature valid.

**Two smaller pieces of housekeeping came out of the same read.** The v1 header copy existed in two places
at once, in `app.js` and in the payment module; two owners for one behaviour on the payment path is how a
later edit deletes it from one and leaves the other looking authoritative, so there is now one, in
`src/x402.js`. And the rate limiter, which used to be a single 60/minute bucket covering the 402 challenge
itself, is split by cost: a request that cannot reach an engine gets a far higher ceiling, because
throttling a compliance sweep does not protect anything and a 429 is not a 402.

**The general lesson is about the audit rather than the fields.** Every one of these passed a green 402,
passed the platform's own compliance checker, and passed a full paid sweep of all twenty-two services.
What found them was reading our own documentation back against the running service, line by line. A
document that describes the system precisely enough to be **wrong** is worth more than one that stays
vague enough to stay right.

Suite 386/381/0/5, `gates/gateSDK-x402.mjs` now 34 checks, docs-consistency across 267 documents.

## 1 August 2026 (later) — one character in a header crashed the container, and the first full paid sweep found it

**The migration entry below is still true and this one is its correction.** Once the payment layer was
live, all 22 services were bought with real money on X Layer. Fifteen were delivered and settled; the
other **seven returned HTTP 502**, and the cause was a single character this service shipped hours
earlier.

The non-chargeable path set an informational header whose value contained an em dash. Node rejects any
non-Latin-1 byte in a header value with `ERR_INVALID_CHAR`, the throw landed in an async Express handler
with nothing to catch it, and it **killed the process**. So every service whose engine refused its own
answer took the whole container down, and the next two requests behind it met the platform edge during a
restart. That is why the failures came in clusters of three rather than scattered.

**The billing side came through it exactly.** Fifteen calls claimed 0.295000 USD₮0; the buyer's balance
fell by 0.295000, the operator's rose by 0.295000, and an independent scan of the token's transfer log
over the sweep's own block range found fifteen transfers totalling 0.295000 with every receipt hash
present on chain. **Nothing was charged for any of the seven that failed.** The direction of failure was
the one a paid service should prefer, which is the only reason this reads as a defect rather than a
theft.

Two things changed, and the second matters more than the first. The header value is now plain ASCII.
And it is written inside a guard, because an informational header must never be able to fail a paid
call whatever a later edit puts in it. `gates/gateSDK-x402.mjs` now drives a real refusal through the
HTTP layer and requires the server to still answer afterwards, which is the check that was missing: the
status codes were unit-tested and correct the whole time, and no test ever sent a refusal through
Express.

**With that fixed, the sweep was run again and every service was bought.** Nineteen of the twenty-two
delivered and settled on the first pass; the other three refused their request bodies with a 400, and
were right to. Those bodies come from the routing fixtures, which exist to prove the signpost stays quiet
on a correct call and are deliberately synthetic, so a made-up prediction market, a dummy pool address
and two strings that are not content hashes are exactly what they are supposed to be. **None of the three
was charged.** Re-run with inputs obtained rather than recalled — a Uniswap pool verified on chain before
use, two content hashes taken from free MCP proofs minutes earlier, a market read from the venue's own
open list — all three delivered and settled.

**So the catalogue stands at 22 of 22 delivered and settled, and the money reconciles to the last
decimal**: 0.360000 USD₮0 claimed by receipts, 0.360000 out of the buyer, 0.360000 into the operator
wallet, with an independent scan of the token's transfer log over the sweep's own block range finding
every receipt hash present and none missing. Seven of the delivered answers carried a zk proof, which is
the count this paper publishes. The full record is in `hackathon/field-test/SWEEP22-SDK-RESULT.md`.

The honest summary of the day is that the paid rail was verified end to end and the verification is what
found this. A sweep that had only read the 402 challenge would have reported success.

One last correction, and it is about the instrument again. The sweep's own proof counter read the
`proof` key on every row rather than only on delivered ones, and a refusal body can carry one too, so it
first reported eight proofs where seven were served. A counter that inflates on failure is the same shape
as everything else this entry is about.

## 1 August 2026 — delisted by OKX, and the reason was not a bug in anything we could test

**Quiver was delisted from OKX.AI at 09:31 UTC today.** The listing card said `Listing rejected`, `not
listed`, and carried an empty reason field. The reason arrived by email instead: *"your service is not
integrated with the official OKX Payment SDK, which prevents us from completing verification."*

**Nothing was broken, and that is the uncomfortable part.** Measured within half an hour of the
rejection: all 22 services still stored on chain with correct endpoints and fees; the endpoint answering
`/` 200, `/.well-known/agent-card.json` 200 and a well-formed 402 on every paid route in under half a
second; OKX's own `agent x402-check` passing **22 of 22**; `validate-listing` returning `pass:true` with
zero findings. The last deploy had gone live 27 hours earlier and every watchdog-recorded deploy measured
zero seconds of darkness. A hand-rolled implementation of the protocol, however correct, is not what the
review verifies. It verifies the SDK.

**So the payment layer now runs on `@okxweb3/x402-express` + `x402-core`, and the protocol belongs to
them.** The 402 challenge, `/verify`, the settle decision and the receipt headers are the SDK's. What
stayed ours is policy, and each piece was checked against the SDK's compiled source rather than its
documentation:

· **Both rails still appear in one challenge.** `RouteConfig.accepts` takes an array, so X Layer USD₮0
and Base USDC are advertised together as before.
· **The EIP-712 domain is unchanged and still verified against the chain.** Prices are handed over in the
explicit `{asset, amount, extra}` form rather than as a dollar string, so no token registry gets the
chance to resolve USD₮0 for us. Preflight rebuilds both domain separators from the live contracts and
they match.
· **A refusal is still free.** The SDK skips settlement entirely at `res.statusCode >= 400`, so the
status code is now the mechanism. An answer the engine rejected returns 400 and one whose own self-check
failed returns 422, where both used to return 200. **This is the single API change**: the response body
is identical, only the status moved, and it moved so that a caller is not charged for an answer we will
not stand behind.
· **The BUG-011 rule survives.** A settlement reporting success with no transaction hash still never
counts as settled, and the recurrence counter now reads the receipt the SDK writes rather than the
attempt — the same rule that stopped seven unsettled calls being reported as traction in July.

**Four defects were found on the way, all four by probing the running service.** The facilitator base URL
was passed with its path already attached, so the SDK appended its own and earned a 403 that read exactly
like bad credentials. `initialize()` reported success while the X Layer rail had no supported kinds at
all, because one facilitator answering counts as success — readiness is now asserted per network. With
the facilitator sync disabled the service answered 402 with an **empty `accepts`**, the precise failure
that makes an ASP unpayable; with it enabled and the facilitator unreachable, every paid route answered
**500**, which would break the one thing x402 actually mandates. Initialisation is therefore retried with
backoff behind a fallback that keeps answering a correct, payable 402 and never serves the resource.

**And two of the failures were in the instrument, not the service.** A new gate compared the challenge in
the header against the mirror in the body with `JSON.stringify` and called them different because the SDK
writes `amount` before `asset`; and it fired sixty-six requests into a service that rate-limits at sixty a
minute, then read the 429 bodies as unpayable challenges. Both were fixed in the gate. The reason the
empty-body challenge was caught at all is that two instruments looked at the same claim from different
sides and disagreed.

Unchanged for anyone already integrated: the endpoint, the header a client sends (`PAYMENT-SIGNATURE`,
which is what the SDK reads too), all 22 prices, and the engine hash `q1-e1fa99d08887d6cc` — the payment
layer sits outside `src/engine/`, so every published proof still reproduces. Suite 386/381/0/5, preflight
37/37, and `gates/gateSDK-x402.mjs` asserts the challenge shape on both the SDK path and the fallback.

## 31 July 2026 — the headline circuit is built and correct, and it does not run on this container

**The honest version of this entry is that it was written twice.** It first said `lp-risk` now proves its
headline. It does not, and the reason is worth more than the feature.

**What is true.** `lpclosed` certifies E[IL](v) = exp(−v/8) − 1, the number at the top of the answer, where
`lpbracket` certifies the breakeven beneath it. The maths is exact: IL(r) = 2√r/(1+r) − 1 is sech(ln r / 2),
and under the martingale lognormal its expectation is E[√r] = exp(−v/8), checked against an independent
fine midpoint rule at v = 0.5, 1, 5, 20, 50, 100 and 200 to 1.3e-13 or better. Certifying the closed form
costs **3,854 R1CS / 7,471 Plonk** instead of the 36,613 the quadrature would. It is the first circuit here
that needs `hez_final_13`, domain 8,192, since snarkjs refuses the smaller ceremony outright. Locally it
proves in **2.7 seconds**, verifies against its published key, and refuses a tampered signal.

**What is not true is that a caller can get one.** On the deployed container the prover exits with code
`null` — a kill signal rather than an error — every time. `lpbracket` at 7.1 MB and `kelly` both still
prove there, so it is this circuit's **16.6 MB zkey at domain 8,192 against the container's memory**, not
the wiring.

**So it is withdrawn from the served paths rather than left reporting an error, and that choice is the
point.** The prover worker is **shared**. A crash on every `lp-risk` call is not a private failure: it
endangers the proofs that do work. A feature that degrades its neighbours is worse than a feature that is
absent, and the absent version is honest about itself.

Kept: the circuit, its artifacts, `zk/scripts/gateLPC-closed-form.mjs`, `src/util/lpClosedSnark.js` and
`src/util/lpClosedForm.js`. Nothing about the mathematics was wrong, and
`docs/pending-deploys.md` records what serving it would take. Everything a caller already had is unchanged:
contentHash `ea18edac…`, `q1-e1fa99d08887d6cc` unmoved, `lpbracket` still building and verifying live.

**Two defects were found on the way, both by testing the deployed container rather than the code.** The
first shipped the proof unreachable: a second proof for one answer is stored as `<hash>:lpclosed`, and
`/proof/:contentHash` validated 64 hex characters and nothing else, so it answered `bad_content_hash` to
the exact URL the response had just published. That route now accepts an optional `:<circuit>` suffix
matched against known circuit names, and **that fix stays** — it is what a second proof will need whenever
one can be served. The second is the memory limit above. Every local check passed both times: encoder,
worker, prove, verify, tamper refusal, preflight 37/37, `npm test` 386/381/0/5. None of them is the
container.

**One mistake in the wiring itself, recorded because nothing shipped from it.** The first attempt used a
string `replace` on `env.snark = snark;`, which takes the first match, and both served files carry two —
the earlier belongs to `options-risk`. The proof was attached to the wrong service. A test caught it before
any commit.
## 31 July 2026 — every one of the 22 answers correctly when asked correctly, and the input-attestation census is confirmed against the paid service

**Verification only, nothing changed.** The earlier sweep left six services returning HTTP 400. Every one of
those was our caller's fault, not the service's: each declares its required fields in the 402 challenge's
own `outputSchema.input.body`, and reading that rather than guessing produced bodies all thirteen paid-only
services accept. **13 of 13 returned 200.** `tape-pulse` wants `{chain, address}`, not a symbol and a bar;
`exec-verify` wants `{amountIn, amountOutRealized}`. The services were right and the caller was wrong.

**The input-attestation register was then checked against live paid answers rather than against source.**
`src/util/inputClaims.js` holds the census and it is confirmed: **2 available** (`perp-gate` via HyperEVM
precompiles, `portfolio-gate` via dYdX ICS-23 store proofs), **3 possible but unbuilt** (`lp-desk`,
`calldata-x`, `poly-desk`), **1 partial** (`protocol-pulse`), **8 with no mechanism at all**, and **8 that
need none** because they compute from caller inputs only. `gate:d4`, the negative gate that checks the
services which *cannot* attest do not claim they can, is **32 of 32**.

**Where the road actually goes.** The three marked possible-unbuilt are the tractable increment, and they
are tractable for one reason: they read **chain state**, which already has a canonical commitment in the
block `stateRoot`. An `eth_getProof` makes those inputs verifiable with no new trust assumption and no new
hardware. The eight marked none read venue APIs, which commit to nothing a third party can check, and no
amount of circuit work reaches them. That is the honest end of this road: it is a TEE or zkTLS problem, not
a proving problem.

**A correction to our own measurement, recorded because it is the kind that flatters.** A behavioural probe
classified 14 of 22 as observation services by looking for an `observation` key on the response. That key is
the **envelope** — engine, version, codeHash — and every service carries it, so the probe was measuring a
key name rather than a meaning. It also counted `poly-fill` as deterministic when its 200 carried a refusal,
because the market slug we sent was invented. The register was right on both and the probe was wrong.

## 31 July 2026 — all 22 services bought with real money on the rail that had been unpayable

**Verification, not a change.** Immediately after the fix below shipped, every one of the 22 services was
bought on the X Layer rail with real funds: fetch the 402, sign `accepts[0]` from a real wallet, replay with
the `PAYMENT-SIGNATURE` header. No free MCP calls, so a pass here is a settled purchase rather than a free
call wearing a paid label.

The first one settled on chain in under five seconds, buyer `…1f9b` down 0.010000 USD₮0 and `payTo` up the
same, and the answer's contentHash was byte-identical to the free MCP call for the same inputs.

**Billing is exactly as advertised, and the reconciliation is worth writing down because it caught a
mistake of ours rather than of the service.** Total spend across the sweep was **0.280000 USD₮0**. That
looked like 28 charges for 22 calls until the prices were read rather than assumed: they are not flat.
Fourteen services are 0.01, three are 0.02, three are 0.05 and two are 0.005. The fifteen calls that
genuinely answered sum to exactly **0.280000** at their published prices.

Which leaves the two cases that matter to anyone paying:

- **A rejected request is not billed.** Six services returned 400 on our bodies. Measured in isolation on
  `tape-pulse`: balance before 22.812323, after 22.812323, charged **0.000000**.
- **A 200 carrying a refusal is not billed either.** `options-risk` answered 200 with `ok: false` and its
  0.02 does not appear in the total, which is what makes the arithmetic come out exactly.

## 31 July 2026 — the X Layer rail could not be paid, because we told payers the wrong signing domain

**This is the most serious thing found in this round, and it was on the primary rail.** X Layer is the chain
the ERC-8004 identity lives on and the first entry in every `accepts` array we serve. A buyer following our
own 402 challenge could not pay it. Not "would be overcharged", not "would get a confusing error": the
signature they built was rejected by the token, with the request well-formed and the balance present.

**What was wrong.** The 402 challenge publishes `extra: {name, version}` for each rail, and an x402 `exact`
payer builds the EIP-712 domain for its `transferWithAuthorization` signature out of exactly those two
strings. We published `{"name":"USDT","version":"2"}`. Read from the token itself at
`0x779Ded0c9e1022225f8E0630b35a9b54bE713736` on chain 196:

```
on-chain DOMAIN_SEPARATOR    0xd591d9baf744328d9400b923cb02c9474d367d591ca1ab24d8c4068be527599d
rebuilt from "USDT" / "2"    0xb219b85d43866ca0283e4ec96d5e1acbbb33416df8f36e6defac5918b55a72a4
rebuilt from "USD₮0" / "1"   0xd591d9baf744328d9400b923cb02c9474d367d591ca1ab24d8c4068be527599d   ← match
```

The token's `name()` returns **`USD₮0`**, not `USDT`, and its version is **1**. So every signature a payer
built from our challenge hashed under a domain the token does not recognise.

**Base was checked in the same run and is correct.** `{"name":"USD Coin","version":"2"}` rebuilds Base's
separator exactly, which is consistent with the fact that a real 0.01 USDC payment has already settled there.
The defect was on X Layer only.

**Why nothing caught it.** Every test that touches payment asserts the *shape* of the 402 challenge, and the
shape was perfect: two rails, correct asset addresses, correct decimals, correct `payTo`, correct amounts.
Nothing rebuilt the domain those two strings imply and compared it to the chain. A field can be
well-formed, well-typed, present on both rails, and still wrong in the only way that matters.

**What changed.** The two defaults in `src/config.js`, and both remain overridable by environment, because
the right answer is a property of the deployed token rather than of our source. `gates/preflight.mjs` now
rebuilds the separator from whatever the config produces, for every rail, and compares it to the token. A
rail whose token cannot be read is a **failure** rather than a skip, because a rail nobody can read is a rail
nobody has checked, and that is exactly how this survived.

**No hash moves.** `src/config.js` is outside `src/engine/`, the codeHash is `q1-e1fa99d08887d6cc` before and
after, and no contentHash is affected: this changes what a payer signs over, not what any service computes.

## 30 July 2026 — correcting the verify instruction did not reach the proofs that were already stored

**Fixing the code fixed the future and left the past broken, which is worth stating plainly.** The previous
entry corrected the sentence every proof publishes for checking itself. Tested against the live service
immediately afterwards: a **fresh** proof carried the corrected wording, and a proof built before the deploy
still published the old one. Proof documents are stored, and `/proof/<contentHash>` served `rec.verify`
verbatim, so each one keeps whatever text was current on the day it was proved. No amount of editing code
would ever have reached them.

**The instruction is now derived when the proof is served, not when it is built.** One exported function
replaces seven inline copies, and `/proof/<contentHash>` calls it for the record's own circuit, falling back
to the stored string only for a circuit this build does not know. So a proof from any past deploy is
described by today's wording. `verify` is documentation and sits in no hash preimage, which was measured
rather than assumed, so nothing verifiable moves and no contentHash changes.

**Why it was seven copies in the first place is the actual lesson.** The same sentence was written out once
per circuit, so it could drift between them and a correction had to be applied seven times. It is one
function now, and the reason is in a comment above it rather than in a commit message nobody will read.

**The watchdog gained a third marker form, because this deploy had nothing the other two could see.** A
marker must be something only the new build can produce. The change here was entirely in served wording, so
there was no key to point at in `/build` and no path in an MCP answer. Rather than deploy unwatched, or
invent a build key purely to be watched, `--marker "get:/path:substring"` fetches any path and waits for the
substring. An unreachable path stays undecided rather than counting as absent, because unreachable is
darkness and the watchdog already tracks that separately.

## 30 July 2026 — every deterministic service now serves a proof, and the instruction for checking one did not work

**Seven of seven deterministic services emit a proof on the live container, up from three.** `exec-verify`,
`event-vol`, `lp-risk` and `options-risk` were wired in the repository and had never been deployed. Measured
from outside against the free MCP surface before and after: three carried a `snark` block, now seven do.
`q1-e1fa99d08887d6cc` is unmoved, the service list is still 22 with 9 MCP tools, and the container answered
every poll through the swap, so the darkness was **0 seconds**.

**Then the deploy was tested as a buyer, and the instruction we publish for verifying a proof turned out not
to work.** Every proof carries `verify: "snarkjs plonk verify <circuit>_vk.json publicSignals proof — the
verification key is published at /proof/vk/<circuit>"`, and the key endpoint's own note said `Verify with:
snarkjs plonk verify <this> <publicSignals> <proof>`. Both imply the endpoint returns a key. It returns the
key **wrapped**, as `{protocol, circuit, note, verificationKey}`.

So a reviewer who does exactly what the page says saves the response to a file, runs the command, and gets
`TypeError: Cannot read properties of undefined (reading 'toUpperCase')` from inside snarkjs. The proof is
fine. The instruction is not. Both were run to be sure: the wrapper crashes, and the same proof with the
`verificationKey` field extracted returns `PLONK VERIFIER STARTED / OK!`.

**The wording now names the field and gives a command that runs.** Seven `verify` strings and two endpoint
notes were rewritten. The command deliberately uses `node` rather than `jq`: `jq` is not installed on this
machine and is not guaranteed on a reviewer's, while anyone who can run `snarkjs` already has Node, and
publishing a command that needs a tool the reader may not have is a milder version of the same defect. The
new text was then followed verbatim against the live service, with nothing from this repository: `curl` the
endpoint, run the published one-liner, run the published verify command, `OK!`.

**None of this moves a hash.** The `snark` block is named in `proof.excludedFromContentHash`, and it was
measured rather than assumed: the same call with and without `snark: true` returns contentHash
`ea18edac…` both times. The strings live in `src/app.js` and `src/util/snark.js`, both outside `src/engine/`.

**Preflight gained three checks and is now 34.** They assert the shape the endpoint actually serves and that
every instruction about to ship names the field to extract, counted as 2 of 2 notes and 7 of 7 verify
strings. The check reads what is about to ship rather than what is live, because a check that asserted the
live wording would block the only deploy able to satisfy it, which is a gate that cannot pass rather than
one that cannot fail.

**One thing went wrong on the way and is worth recording.** The first rewrite inserted a `node -e
"require('fs')…"` one-liner into a single-quoted JavaScript string, so the inner apostrophes closed the
literal and `src/util/snark.js` stopped parsing. Nothing shipped: the module was restored from the mirror,
the rewrite was redone with the apostrophes escaped, and it now import-checks both files before writing
anything back.

## 30 July 2026 — the flagship circuit is now rebuildable from a clone, and four published counts were stale within a day

**Nothing a caller sees changes.** `q1-e1fa99d08887d6cc` is unmoved and no contentHash moves. This is about
what a reviewer gets when they clone the repository and try to reproduce our numbers, which is the claim we
ask to be judged on.

**The defect register said five artifacts were missing while one of them was already there.** §8 of
`KNOWN_DEFECTS.md` read "the 5 missing artifacts are still missing". Asked of `git ls-files` at HEAD one file
at a time rather than as a group, commit `ddcc434` had already shipped `zk/build/liquidation.r1cs`, so the
true figure was **1 of 5 closed**. The other four are shipped now: `liquidation_plonk.zkey` (5,436,000
bytes), `vk_plonk.json` (2,043), `liquidation_js/liquidation.wasm` (47,368) and
`liquidation_js/witness_calculator.cjs` (10,356). 5.5 MB, comfortably inside a convention this repository
already keeps, since four zkeys it tracks are larger and the largest is 24,672,856 bytes.

That matters because `gateB6-portfolio-routes.mjs` is the one gate that proves against
`zk/build/liquidation_*`. It could not run from a clone at all, which is a harder failure than the seven
`evmRehearsal` gates that stop for want of `solc`. It can now.

**The gate caught the stale disclosure, and it was measuring the wrong thing while doing so.** §8's claim is
about five named artifacts; the test compared which **circuits** lack a `.r1cs` in the mirror. Those drifted
apart twice in one day. First `liquidation.r1cs` shipped, so no circuit was absent while four artifacts still
were. Then `lpclosed` and `lpclosed2` were compiled and the test went red naming `[lpclosed,lpclosed2]`, a
true observation about a claim §8 never made. The test now asserts the artifact list at HEAD, and the
circuit-set question became its own check with a floor, so a mirror listing too few files cannot pass on
nothing.

**Four published counts went stale because of this work, and the gate found all four.** Compiling two
circuits moved: circuits in this checkout 21 to **23**; circuits with no private input at all 18 to **20**,
because both new ones declare `nPrvIn` 0 and so land on the wrong side of §4's defect; ceremony files on disk
2 to **3**, since `lpclosed` needs `hez_final_13`; and §13's committed-artifact row 0 of 38 to **2 of 38**.

The last one deserves its distinction rather than a number. Those two circuits are the only adversary sources
a clone can rebuild: their `.r1cs` and the ceremony file they need are committed, so `plonk setup` regenerates
the zkey in about 930 ms. The other thirty-six have no committed `.r1cs` and no clone can rebuild them at any
price. Saying "2 of 38" without that would flatter the position.

**Two checks were repaired rather than satisfied.** The ceremony assertion required every `.ptau` to be
4,801,688 bytes, which held only while they were all power 12; it now reads each file's declared power out of
its own header and checks the size that power should have, and also refuses a file whose name and header
disagree. And the scripted revert that proves gate N can fail had been planting a fake `liquidation.r1cs` in
the mirror; once the real one was committed it correctly refused to start, and in refusing it stopped proving
anything. It now builds the same asymmetry from the other side, copying a real `.r1cs` into the dev tree under
a name no clone has. Thirteen mutations, every one red where it should be, both register copies restored byte
for byte.

## 30 July 2026 — the exact expected impermanent loss needed no engine change, and the ceremony claim was in the wrong units

**Nothing a caller sees changes, and that is the finding.** `q1-e1fa99d08887d6cc` is unmoved, measured
before and after this work, and no contentHash moves. A recorded probe had concluded that certifying
`lp-risk`'s expected divergence required editing frozen engine code. It does not.

**What the probe got wrong, twice.** `zk/build/probe-lpclosed-cost.json` concluded "the ceremony file is
NOT what blocks proving block 2 ... the fix is engine-side ... and `src/engine/` is frozen".

The first half compared an **R1CS** count of 3,023 against a **Plonk** domain ceiling of 4,096. Those are
different units. Reading the zkey headers of four circuits this repo already built gives the inflation:
`lpbracket` 932 to 1,776 (1.9056×), `ncdf` 2,051 to 3,812 (1.8586×), `kelly` 372 to 718 (1.9301×),
`liquidation` 667 to 1,301 (1.9505×). So 3,023 R1CS projects to about **5,619 to 5,896 Plonk**, needing
domain **8,192** at every ratio in that band. `hez_final_12` is not big enough, and `ncdf` already sits at
3,812 of 4,096, so the ceiling is real and close. But `hez_final_13` is a **public download**: it touches
nothing under `src/engine/`, so it moves neither the codeHash nor any contentHash.

The second half asked whether the engine *serves* the exact value. It does not, and that is not the
question that decides anything. The question is whether the exact value can be **computed** from what the
response already publishes, and it can. Verified against the live service: `volatility` comes back as
`0.0123456789` and `horizonPeriods` as `7`, both verbatim and unrounded, and both also appear inside
`proof.inputs`. So `v = σ²T = 0.0010669105125133366` exactly, outside the engine.

**Not from `totalVariance`.** That field is published but rounded to 6dp, and rebuilding `v` from it is
lossier than the very error this is about: at `σ = 0.0123456789, T = 7` it shifts the answer by 1.12e-6
percentage points, roughly eight times the 1.4191e-7 pp quadrature envelope.

**The arithmetic, checked rather than recalled.** `IL(r) = 2√r/(1+r) − 1` is `sech(X/2) − 1` for `r = e^X`,
and under the martingale lognormal the engine assumes, `E[sech(X/2)]` equals `E[√r] = exp(−v/8)`. Measured
against an independent fine midpoint rule at `v` = 0.5, 1, 5, 20, 50, 100 and 200: agreement to 1.3e-13 or
better throughout. So `expm1(−v/8)` is the exact expectation and the engine's 401-point trapezoid is the
approximation, with a peak truncation error of **1.4191e-7 percentage points at v = 1.1255**.

**What was added.** `src/util/lpClosedForm.js`, entirely outside the engine, recovers `v` exactly and
evaluates the closed form. It is **fail closed**: it compares the exact value against the served figure and
refuses when they do not round alike, when either field is missing, or when `concentrationFactor` is not 1
(the engine amplifies or reverts in that case, so the comparison would be between two different
quantities). Nothing here ever asserts a digit it cannot back.

**One correction to our own reporting.** The mismatch count is meaningless without its domain, because the
error peaks sharply at `v ≈ 1.13`. Forty thousand samples over `(0, 166]` give **3** last-digit
disagreements; forty thousand over `(0, 20]` give **22**. Both are correct for their grid, and quoting
either without the domain is not.

Also recorded because it caught a real mistake: the first version of the new test asserted the gap against
the quadrature envelope alone and failed at 1.917e-5. The served figure is already rounded to 4dp, so the
observable gap is bounded by the display half step plus the envelope. The two are now separate fields,
because collapsing them is a mistake this project already shipped once in a proof guard that measured
display rounding and therefore measured nothing below a dollar.

## 30 July 2026 — the harness that proves our gates can fail was corrupting the tree it tested

**Nothing a caller sees changes.** No endpoint, no response shape, no contentHash, and the engine build
hash is still `q1-e1fa99d08887d6cc`. This is about the tooling that backs up every "this gate can fail"
claim we publish, and it is recorded here because the fault could have put a file into the repository
that nobody wrote.

**What was wrong.** A revert script proves a gate is load-bearing by writing a scripted defect into a
real file, running the gate, requiring red, then restoring the file. The restore lived in a `finally`.
On this platform a `finally` cannot run: measured with node v24.11.1 on win32, `child.kill('SIGTERM')`,
`('SIGINT')` and `('SIGBREAK')` all report exit code `null` and run **no** handler, not the signal
handler and not even the `process.on('exit')` hook, because Node maps them to `TerminateProcess`. And a
full run is longer than the timeout that kills it: `gateAT-attest-no-snark.mjs` takes **45.6s** measured
and the revert runs it seven times, so about **320s** against a 120s default. Being killed mid-patch was
the normal outcome, not the exception.

**What made it permanent rather than merely annoying.** The old code copied the target over its backup
*before* checking anything. So an interrupted run left a patched file next to a pristine backup, and the
next attempt overwrote that pristine backup with the patched file, after which the baseline check failed
and the `finally` restored the defect. Both halves are now demonstrated in
`zk/scripts/gateAT-guard-selftest.mjs` scenarios 6 and 7: the unguarded shape loses the file on SIGTERM,
and its second run destroys the only pristine copy that remained. This had already happened twice, to
`src/util/repair.js` and `src/util/routing.js` (recorded in `docs/elapsedms.md` 6.5) and to
`gateAT-attest-no-snark.mjs`, and both times the committed mirror was the only surviving clean copy.

**The scope was not one script.** Of 37 revert scripts, **31 write to a file on disk**, and **0 of 31**
installed a signal handler, **0 of 31** guarded an existing backup at startup, and only 4 of 31 checked
the target was green before snapshotting it. None of them writes under `src/engine/`, which was verified
rather than assumed: the `engine/proof.js` paths in that harness are imports used to read the build id on
both sides of the run, and `gateLB-revert.mjs`'s `src/engine/lpRisk.js` references are a comment and a
line of injected patch text. The frozen engine hash was never exposed.

**What changed.** `zk/scripts/lib/revert-guard.mjs` treats a backup on disk as evidence instead of
garbage: it never overwrites one, it tells a live sibling from a dead one by pid so a concurrent run is
refused rather than clobbered, it verifies the target against the mirror's `HEAD` *before* taking a
snapshot, and it restores on every exit path that this platform actually offers.

Because the interrupted run cannot clean up after itself here, the load-bearing defence is one that runs
later: `zk/scripts/revert-heal.mjs` finds abandoned backups and files that both differ from `HEAD` and
carry a scripted-defect marker, and repairs them. The marker condition is deliberate. This tree always
holds real uncommitted work, so healing on "differs from `HEAD`" alone would destroy it. It refuses to
act on anything a live revert script owns, and `gates/preflight.mjs` now runs it as check 30 and 31, so a
tree holding a scripted defect cannot reach a deploy.

**How we know it works, including that it can fail.** The guard selftest asserts the file really was
patched before each kill, which is what caught two earlier versions of the selftest passing vacuously:
once because a Windows ESM specifier killed the child before it patched anything, and once because
`await new Promise(() => {})` is detected as an unsettled top level await on Node 24 and exits the
process by itself, so the scenario was measuring Node's own exit path rather than SIGTERM. The healer was
then given real wreckage to find: a defect injected into `gateAT-attest-no-snark.mjs` plus a backup and a
dead pid lock. It detected all three, repaired the file to its exact prior hash `9ea53255…`, and left
nothing behind. In the same run it **declined** to touch `src/util/snark.js`, correctly, because
`gateMR-revert.mjs` was genuinely mid-flight and holding it.

## 30 July 2026 — `options-risk` can be asked for a proof, and it certifies all six greeks at once

**What a caller sees change.** `POST /api/options-risk` (and the free MCP `options_risk`) now accept
`snark: true`. With it, the response carries a new top-level `snark` sibling — the same shape the six
other proof-emitting endpoints use — naming the circuit, where to fetch the proof, the envelope on each
greek, the envelope in **price terms**, and a `proves` / `doesNotProve` pair. Without `snark: true`
nothing about the response changes and **no contentHash moves**: verified directly, a fixture book
hashes to `2f233f76…` before and after. `snark` is attached outside `proof`, so
`proof.excludedFromContentHash` names it automatically and the published recipe still reproduces.

**One contentHash does move, and it is disclosed rather than buried.** A request that already sent
`snark: true` to this endpoint previously had that flag hashed *as an input*, because the handler passed
the whole body through. It is now stripped before the envelope is taken — `snark` is a transport flag,
not a risk input — so such a request moves from `c3624b37…` to `2f233f76…` and now agrees with the
same book asked without the flag. That is the behaviour every other proof-emitting handler has had since
each was wired. No published artifact quoted the old value: there is no pinned `options-risk` hash
anywhere in the repository, Appendix C still reproduces at `8575ce5a…`, and
`gates/gateV-recipe-reproduces.mjs` confirms not one deterministic hash moved.

**What is proven.** Six fields off **one** instance of a circuit that already existed — no new circuit,
no new ceremony, no new verifier, the same `ncdf_plonk.zkey` and the same `/proof/vk/ncdf` that
`event-vol` uses. At `r = 0` every greek is a rational function of exactly two transcendentals taken at
the **same** point `d1`: `delta` is `N(d1)`, and `gamma`, `vega`, `vanna`, `volga` and `theta` are each
`φ(d1)` times a coefficient in `F`, `K`, `T` and `σ` — `theta` included precisely because its `r·price`
term vanishes at `r = 0`. The circuit evaluates both by Hart (1968) with a range-checked remainder on
every multiply, so the prover cannot choose a rounding. **In price terms the envelope is ±1.11e-6 quote
units of dollar delta per contract on a 100,000 forward** (1.11e-7 bps of the forward). A service running
Abramowitz-Stegun 7.1.26 instead of Hart — which satisfies every greek *consistency* identity and is
still wrong about the level — is refused on **99.478%** of legs, and misstates dollar delta by up to
6.881e-3 on the same legs.

**What is NOT proven, and is said so in the response.** That `x` is this leg's `d1`: the circuit takes
the point as given, and binding it is one **exponential** a reader performs —
`K·exp(σ√T·x − ½σ²T) = F`. `portfolioValue` is not proven, because the premium needs `N(d2)`, a second
CDF point, and once `K ≠ F` no identity collapses the two. Neither is `spanMargin`, which is the worst of
366 repricings. Scope is **one leg at `r = 0` below the 7.0711 tail split** — 98.60% of legs are below it
— and a multi-leg book, a discounted book, a leg past the split, and any leg whose envelope would be
wider than the digit a greek is displayed to each get a **named refusal** instead of a proof.

**Verification.** `zk/scripts/gateB7-7-optionsrisk-greeks.mjs`: 44 checks, 0 failures, 3,812 Plonk
constraints, 274,238 gas to accept and 573 to refuse in an EVM, 0 bound violations over 19,719 legs of
the real engine with the worst honest leg using 99.9965% of the derived bound.
`zk/scripts/revert-optionsrisk-greeks.mjs` breaks seven things and requires a named check to go red for
each — including one that does **not** go red, published as a measurement rather than removed. The
engine build hash `q1-e1fa99d08887d6cc` does not move, nothing under `src/engine` was touched, and
`npm test` is unchanged at 386. Full write-up: `docs/wire-options-risk-greeks.md`.

---

## 30 July 2026 — "prover busy — retry shortly" now means something when you retry

**What a caller sees change.** No response *shape* moves and no contentHash moves. What changes is what a
**second identical request** does after the first one was refused for a full queue. That refusal reads
`unavailable — prover busy — 8 proofs already queued; retry shortly`, and until now retrying did nothing:
the refusal was cached under the request's content hash, and the cached record satisfied the same guard that
stops a finished proof being proved twice. Now a stored record that is neither `ready` nor `building` is
re-attempted, so the retry the sentence asks for actually rebuilds. The engine build hash
`q1-e1fa99d08887d6cc` does not move — nothing under `src/engine` was touched — and `npm test` is unchanged
at 386.

**Measured before anything was changed,** on the served `event-vol` handler: twelve distinct bodies with
`snark: true` fill the 8-deep queue (8 admitted, 4 refused), a thirteenth is refused the same way, and after
the prover goes **completely idle — 12.2 s** — the identical body leaves the record untouched, same status
and the same `at` stamp. Nothing was in the prover and the request that would have been admitted was answered
out of a cache holding a statement about a moment that had passed. After the fix, the same body at the same
point returns `ready`.

**Why it was wrong in the file's own terms.** `src/util/proofStore.js` already refused to *persist* a
refusal, in writing, because "a refusal is a judgement made by one build of the code". The durable layer had
the right policy and the in-memory guard in front of it contradicted it. The entry below records this exact
gap as "NOT fixed, and recorded rather than folded in"; this is it closed. Seven builders share the guard —
not six, as that entry says — and all seven are patched, on both the paid HTTP surface and the free MCP one.

**What is deliberately still memoised.** A `ready` proof, because proving is 703 ms of a core and a repeat
must keep costing nothing, and a `building` one, because that record is the only marker that a hash is in the
prover. A **permanent** refusal — a position the 1e-9 grid cannot pin to the digit its answer is displayed
at, an encoder's witness reason — is now re-derived on every request, so this was measured rather than
assumed: over three runs of 50 to 200 identical re-attempts, three such refusals produced **one** sentence
apiece and added **0.015–0.057, 0.019–0.049 and 0.687–1.406 ms** per call to re-derive, the last being the
lp-risk bracket whose witness replays a 200-halving bisection — and even that is less than the 1.687 ms the
same request costs with no proof asked for. None of them can reach the prover: every refusal in the file is
written before the queue is consulted, which is also why a permanently refused request keeps its own sentence
instead of being told to retry forever — asserted with 8 proofs in flight.

**Verification.** `gates/gateMR-memoised-refusal.mjs` (`npm run gate:mr`): 10 checks, every one behavioural,
driving `SERVICES[].run` and the MCP `TOOLS[].run` and reading the store through `getProof` — including two
floors that assert the queue really filled, so "the retry rebuilt" cannot pass on a process where nothing was
ever refused. `gates/gateMR-revert.mjs` puts a defect back five ways — the old guard in all seven places, an
in-flight build no longer blocking, a finished proof no longer blocking, a refusal that leaks a queue slot,
and the transient check moved ahead of the permanent ones — and requires the gate to go red on each, naming
it, while a named companion check stays green: **5 of 5**. `gates/gateIF-inflight-eviction.mjs` stays green,
Appendix C still reproduces at `8575ce5a…`, and no deterministic hash moved. Full write-up:
`docs/fix-snark-memoised-refusal.md`.

---

## 30 July 2026 — a proof that was being built could be reported `unavailable`, and now cannot be

**What a caller sees change.** Nothing about any response *shape*, and no contentHash moves: this is a
correction to what `GET /proof/<hash>` says while a proof is in flight. Under load, that endpoint could
answer `unavailable — prover busy` for a proof the prover was working on at that moment, and then land
the real `ready` record after the caller had already stopped polling. It now stays `building` until the
proof settles. The engine build hash `q1-e1fa99d08887d6cc` does not move — nothing under `src/engine`
was touched — and `npm test` is unchanged at 386.

**The mechanism.** `/proof/<hash>` is served out of a 200-entry cache. All six proof builders open with
the same guard against proving one content hash twice — `store.has(contentHash) || claimed.has(contentHash)`
— and `claimed` is released when a build is *enqueued*, not when it finishes. So from enqueue to `ready`,
the `building` record in that cache was the only marker that the hash was in flight, and eviction was
insertion-order and took it like any other entry. A repeat of the *same* request arriving after 200 other
proof requests then passed the guard, started a duplicate build for a hash already in the prover, hit the
8-deep queue limit, and wrote `unavailable` over the record. Measured on the served `event-vol` handler:
one fixture call, 20,200 further distinct-hash requests, the same fixture again — `unavailable: prover
busy` for a request that answers `ready` in about 3 seconds on a quiet process.

**What is fixed and what is not.** Eviction now skips records that are `building`, and does not fire at
all when overwriting a key already in the cache. At most 8 records can be `building` at once, because
that status is written only after the queue admits the build, so the skip cannot make the cache
unbounded — and `gates/gateIF-inflight-eviction.mjs` asserts the eviction *pressure* as its own check
before it asserts that the in-flight marker survived, so "never evict anything" cannot pass it either.
`gates/gateIF-revert.mjs` puts both halves of the defect back and requires the gate to go red on each,
naming it, while the other check stays green. NOT fixed, and recorded rather than folded in: a record
that legitimately reaches `unavailable` is still memoised in memory until it is evicted, even though the
durable store deliberately refuses to persist a refusal for the same reason it would be wrong to reuse
one. *(Closed later the same day — see the entry above. That paragraph is left as written, because what it
disclosed was true when it was published.)*

**Where it showed up.** `zk/scripts/gateB7-6-eventvol-straddle.mjs` — the gate for event-vol's ATM
straddle proof — was red on exactly this, on the two checks that fetch the proof a served response points
at. The circuit, the identity and the guard were all correct. With the fix it is green: 3,812 Plonk
constraints, domain 4096, 7 public signals, 273,920 and 275,584 gas to accept across two runs (a 0.61%
spread, inside the 1.22% this verifier is known to vary by), 573 gas to refuse. `hackathon/WIRE_EVENT_VOL.md`
(mirrored to `docs/wire-event-vol.md`) also re-measures every figure in it against the rebuilt two-sided
`ncdf` key, and records the one that had the sharpest edge on it: `TOLC = 12` is the circom *constant*,
while the band the circuit enforces is `TOLC/2 = 6` ulp, so the published buyer envelope is conservative
only because 12 over-covers the band by 6 while an unnamed 2.11-ulp evaluator term is missing. Correcting
the 12 without adding that term would make the envelope unsound while looking like a fix.

---

## 30 July 2026 — `lp-risk` can be asked for a proof, and it certifies a bracket rather than a number

**What a caller sees change.** `POST /api/lp-risk` and the free `lp_risk` MCP tool accept
`{"snark": true}` and answer with a `snark` block carrying a retrieval URL, a `proves` string, a
`doesNotProve` string, and `/proof/vk/lpbracket` for the verification key. Requests that do not carry
the flag are byte-identical to what they were: both pinned lp-risk fixtures were re-measured and their
contentHashes are unmoved, with and without the flag, and the engine build hash
`q1-e1fa99d08887d6cc` does not move because nothing under `src/engine` was touched. A caller who was
already sending `{"snark": true}` to this endpoint was having it hashed and ignored; that caller's
contentHash moves once, onto the hash the identical body without the flag has always returned.

**What is proven.** `feeVsDivergence.breakevenVolatility` — the per-period volatility at which expected
divergence exactly eats the horizon's fees. The engine finds it by bisecting 200 times over a 401-point
quadrature, which is 163,608 exponentials and 82,016 square roots for one served answer, measured. The
circuit evaluates that quadrature **zero times**. A bisection result does not have to be recomputed to be
certified; it has to be LOCATED, and a bracket is a closed-form object: `g(lo) > 0`, `g(hi) <= 0`,
`lo < hi`, the root at the midpoint to one grid step, a published width bound, and the volatility pinned
on the squared quantity `sigHat^2 * horizonT = vStar * 1e9`. Six inequalities over thirteen public
integers, in 1,776 Plonk constraints — the cheapest circuit on this host, against the most expensive
computation the service performs.

**What is NOT proven, and it is the larger half.** The two endpoint expectations the bracket straddles
with are the engine's quadrature. They arrive as PUBLIC INPUTS and nothing in the circuit certifies them,
so a caller who supplies two wrong numbers that happen to straddle gets a valid proof of a false
breakeven. They are published among the signals and on the proof record for exactly that reason, and each
can be checked in one line: `E[IL](v) = exp(-v/8) - 1` is exact — `2*sqrt(r)/(1+r) = sech(ln r/2)`, and
shifting `z = w + sqrt(v)/2` leaves `sech` against a pdf that gains `cosh`, whose product is 1. That
closed form agrees with the engine's quadrature to at most **1.419121e-9**, which is 71.92% of the
Gaussian weight the engine's `|z| <= 6` window discards — so the gap is the engine's truncation, not
either side's arithmetic. It is also more than one grid step, which is why the closed form is the
cross-check and the engine's quadrature is what gets encoded.

`expectedDivergence.expectedIlPct`, the percentage this service leads with, IS that assumed quadrature
and is not covered. `realizedIL` belongs to a different circuit. Monotonicity of expected divergence in
variance — what makes a straddled root unique — is established by sweep, not by any proof.

**The bound, and what the worst honest case uses of it.** `breakevenVolatility` is published as
`round(sigma, 5)`, so the display half-unit is 0.5e-5 — a hundred times finer than the liquidation
guard's half-cent and ten times coarser than the Kelly guard's half-millionth, which is why it is a sixth
constant rather than a reuse. Swept over 882 real answers: 756 proved, 112 have no breakeven at all
(horizon fees exceed the 100% a bounded loss can reach), **14 refused by the ceiling**, and **0** exceeded
the bound. The worst honest case uses **99.7384%** of the derived bound. The ceiling is reached, not
defensive: `sqrt(v/T)` has unbounded slope at zero, so below about 0.012% fee APR at a one-period horizon
the coarsest bracket whose straddle survives the 1e-9 grid maps to a wider range of volatilities than the
five decimals the figure is published at, and those answers are refused with the measured number rather
than served a proof of a neighbouring breakeven.

The comparison is against the engine's UNROUNDED bisection, replayed in
`src/util/lpBracket.js`, not against the served five-decimal figure. An equality on the rounded value
refused 28 of 770 honest answers, all of them sitting on a 5th-decimal boundary — the same defect that
once refused RUNE a liquidation proof for landing a hair the wrong side of a half-cent.

**How to check it.** `node --test gates/gateLP-bracket-snark.mjs` — 13 checks, including 13 of 13 moved
public signals refused, a bent proof point refused, 9 of 9 dishonest witnesses refused before a proof
exists, and a smallest rejected volatility perturbation of one grid step (1e-9).
`node gates/gateLP-revert.mjs` puts seven defects back one at a time and requires the gate to go red for
each. Two of those seven were GREEN on the first run, which is how the gate acquired the two checks it
was missing; `docs/wire-lp-risk.md` records both, with the numbers.

---

## 30 July 2026 — the `ncdf` verification key changed, because the circuit behind it did

**What a caller sees change.** `/proof/vk/ncdf` serves a different verification key than it did earlier
today, and any `event-vol` proof built before this change no longer verifies. Nothing else moves: no
service response shape, no contentHash, no other circuit's key, and the engine build hash
`q1-e1fa99d08887d6cc` is unchanged. If you are holding an `ncdf` proof from earlier today, ask for it
again — the same request rebuilds it under the new key.

**Why.** `ncdf.circom` bounded its CDF residual with `2·resid + tol <= 2·tol` and, alone among the
twelve circuits in this repository, did **not** range-check the shifted residual first. The generated
header argued that `LessEqThan`'s own bit decomposition would catch a field-wrapped negative shift. It
does not: for `in[0] = p − v` the two wraps cancel mod p and the comparator sees an ordinary in-range
number. So the bound held on **one side only** — the upper tail could be driven arbitrarily below the
truth, which for `x > 0` is `N(x)` arbitrarily close to 1.

**What that was worth.** `event-vol`'s straddle is `2·S·(2·N(x) − 1)`, affine and increasing in `N`, so
the open direction was the direction that inflates. Measured on the service's own witness encoder: at a
spot of 100,000, 60% vol, 30 days, the served figure is 13,707.88 and the old key admitted a claim of
**200,000.00 — 1359% high**, against an `envelopeUsd` of 4.4e-6 published in the same response. The
rebuilt key admits 6 ulp of 2^-40, which is the band the constraint states, and the claim rounds to the
served figure at the last published digit. `zk/scripts/probe-ncdf-onesided-exposure.mjs` reproduces all
of it; `zk/scripts/gateB7-5-ncdf.mjs` §0 shows the pre-fix constraint system satisfied by a claimed
at-the-money call delta of 1.0, worth 369% on a single leg, against the circuit kept for that purpose at
`zk/circuits/adv/ncdfonesided.circom`.

**What is now true and was not.** The band is two-sided at `TOLC/2 = 6` ulp on the CDF and `TOLP/2 = 5`
on the density, verified by walking the witness generator out to four times the band in both directions
and requiring the accepted interval to be closed at both ends. The **envelope to the true CDF** — which
is what a buyer gets, and is not the same number — is `6 + 2.1100 (the evaluator's own error, against a
reference that is neither Hart nor Abramowitz–Stegun) + 0.1995 (half a grid step of x) = 8.3095` ulp
**= 7.5575e-12**. In price terms that is **1.5e-6 quote units per contract on a 100,000 forward at the
money**, against the 2.8 cents that Abramowitz–Stegun 7.1.26 would misprice the same leg by — a ratio of
1.8e4, and every consistency identity in `greeksfp`, `greekssigned` and `parity` is satisfied to 3.3e-14
by A-S and blind to all of it.

**What it cost.** 3,740 → 3,812 Plonk constraints, still inside the 4,096 domain and the same public
Hermez `hez_final_12` ceremony, because the two range checks were sized to the widest *accepted shift*
rather than to the widest product, which shrank the two comparisons by more than the checks added.
Accept gas 272,990 against 273,406 before — inside the measured 1.22% Plonk spread, so unchanged. Full
detail in `docs/wire-options-risk.md`.

---

## 30 July 2026 — `event-vol` can now hand you a succinct proof of its expected-move number

**What a caller sees change.** Send `snark: true` to `/api/event-vol` (or the `event_vol` MCP tool) and
the response grows a `snark` block naming a PLONK proof, built off the request path and fetchable free
at `/proof/<contentHash>`. It certifies **one** published field —
`expectedMove.straddleImpliedAbsMoveUsd` — as `2·spot·(2·N(x) − 1)` for a public point `x`, with `N`
the standard normal CDF **evaluated inside the circuit** by Hart (1968) rather than asserted. Every
answer that does not ask for a proof is byte-identical to before, including its contentHash. The one
request shape that does move is a call that was already passing `snark: true` to this service: that key
used to be hashed into `proof.inputs` and is now read as a preference, exactly as it already was for
`perp-gate`, `size-gate`, `exec-verify` and `treasury-risk`.

**Why this service and not `options-risk`.** The circuit pins `N(x)` *given* `x`, and pinning
options-risk's `d1 = [ln(F/K) + ½σ²T]/(σ√T)` needs a logarithm. event-vol's straddle is struck **at the
forward**, so `K = F`, `ln(F/K) = 0`, and `d1 = σ√T/2` — one point of the CDF, no logarithm. The
remaining binding, that `x` really is `σ√T/2`, is a squaring a reader performs on the public signals in
one line; it is **not** in the proof, and the `doesNotProve` field says so.

**The number it pins, and the number it does not.** The certified straddle sits within **±2.663e-6** of
`2·spot·(2·N(x) − 1)` on a $60,000 spot, against a served precision of 0.005 — so the proof is 1,878x
tighter than the digit the field is published at, and the record carries `straddleFromProofUsd` at full
precision so that is visible. Above a spot of about **1.13e8** the circuit's own 12-ulp envelope is
wider than that last digit, and the proof is **refused with the envelope quoted** rather than served as
a statement about a neighbouring number. Five of the six published fields are outside it:
`probabilityMoveBeyond` needs the CDF at six further points, `eventIsolation` is a variance difference
and a root, `oneSigmaUsd`/`oneSigmaPct`/`rangeOneSigma` contain no transcendental at all, and `checks[0]`
is a 501-point quadrature — an agreement claim between two computations rather than an identity.

**And the honest size of what it catches.** A service running Abramowitz-Stegun 7.1.26 instead of Hart
is refused on 99.99% of legs while pricing this particular field only **0.0007%** wrong — on
options-risk's wider domain the same surrogate is 19.4% wrong. So what the proof buys here is that the
evaluator is *pinned*, not that you are protected from a large mispricing. A surrogate that is
economically wrong (a logistic, 6.66% worst) is refused on every leg.

**The engine build hash is still `q1-e1fa99d08887d6cc`. Nothing in `src/engine/` was touched** — the
whole directory is byte-identical to the mirror. `zk/scripts/gateB7-6-eventvol-straddle.mjs` proves the
route end to end, including the proof a served response actually points at, and
`zk/scripts/revert-eventvol-straddle.mjs` turns that gate red four different ways.

---

## 30 July 2026 — a high-volatility `lp-risk` call no longer ships a failed self-check over a correct answer

**What a caller sees change.** Ask `lp-risk` about an LP position in a 62%-per-period-volatility asset
held for a year and the answer is unchanged to the digit — `expectedIlPct: -100` — but the envelope now
reports `allSelfChecksPass: true` instead of `false`, and the paid path settles instead of replying
`status: "not_charged", reason: "input rejected by engine"`. **The input was never rejected and the
number was never wrong.** The engine's boundedness self-check asserts that its reported divergence lies
in `(-100%, 0]` and was evaluating that on its own 4-decimal display value: once the expectation reaches
`-0.9999995` the display is exactly `-100`, and `-100 > -100` is false. The full-precision expectation
there is **-0.9999999758323288**, strictly inside the interval the check demands. Measured: at
T = 365 periods the first total variance that flips it is **116.06874041832731**, so every
high-volatility LP question above that line shipped this way. It was §5 of the defect register, where it
was disclosed as unfixable because the check lives in the directory the build hash is taken over.

**It was fixable without touching that directory, and the miss is the interesting part.** The register
asked whether the un-rounded value is *published* — it is not, it is a local variable — and stopped. The
question it should have asked is whether anything published lets a caller **recompute** it. Something
does, and it was already written down on the next page of the same register: `E[IL] = exp(-sigma^2*T/8) - 1`
exactly, with `volatility` and `horizonPeriods` echoed in every envelope. So the verdict is now
re-evaluated on that exact fraction in `src/util/lpBoundedness.js`, after the engine returns.
**The engine build hash is still `q1-e1fa99d08887d6cc`. Nothing in `src/engine/` was touched.**

**The strict inequality is asked in L-form, and that is not a detail.** Recomputing `E[IL]` and testing
`> -1` reproduces this very defect one digit lower down: at a total variance of 300, `exp(-v/8)` is
5.18e-17 and `exp(-v/8) - 1` is exactly `-1` in IEEE-754 doubles. So the test is carried out on
`L = 1 + E[IL] = exp(-v/8)`, which `Math.exp` returns directly, and never on `L - 1`. The engine's check
flips at a total variance of 116.07; this one does not until **5961.07**, where `exp(-v/8)` underflows.

**Which content hashes moved, exactly.** `selfChecks` is inside the contentHash preimage, so a corrected
verdict moves the hash of the call it corrects — **741 of the 1,142 calls** on the new gate's sweep, and
no others; the gate asserts that as an equality rather than a containment. Both pinned `lp-risk`
fixtures — `e65cd458…` and `c3997db9…` — and the Appendix C exhibit `8575ce5a…` are byte-identical. For
a moved call, re-running `src/engine/lpRisk.js` **alone** no longer reproduces the response, so the
corrected check carries its own `reEvaluated.reproduce` naming the extra file, a sentence naming it is
appended to `proof.reproduce`, and the SDK's `reproduce()` applies the same step — otherwise it would
answer `reproduced: false` on an honest response, which is the one failure this SDK exists to prevent.

**The correction is one-way and fail-closed, so it cannot invent a pass.** A check that is not already
failing is never touched. A failing one is overridden only when the exact fraction is inside the interval
**and** the recomputation reproduces the published 4-decimal figure. Fed the `-135%` divergence headline
that a live adversarial session produced, the `-200%` amplified figure the old escape hatch shipped
green, or a positive expected divergence, the override is withheld and the check stays red.

**What still fails, and it is reachable rather than theoretical.** `{volatility: 100, horizonPeriods: 1}`
gives a total variance of 10,000; `exp(-1250)` is zero in double precision; the engine's own quadrature
has itself saturated to exactly `-1` (measured: from a total variance of **266.25**); and the served
`-100%` **is** the boundary rather than a rounding of something inside it. That call still ships
`allSelfChecksPass: false` and is still not billed. So does a non-finite variance.

**One residual gap, disclosed rather than smoothed.** For a total variance between
**116.06874041832731** and **116.06926190819375** the engine's quadrature and the closed form round to
different 4-decimal figures — the truncation floor of the engine's own `|z| <= 6` window, worst
**1.41910e-9** — so the guard withholds and the false failure is retained in a band **5.2149e-4** wide.
Its upper end is exactly `-8*ln(5e-7)`. 52 sweep points sit inside it and the gate asserts all 52 still
fail, so the disclosure cannot go stale without going red.

The same defect in `realizedIL`'s sibling check — flipping at a price ratio of 6.25e-14, and at 1.6e13
the other way — was found by sweeping for it and is corrected by the same rule.

New: `npm run gate:lb` (12 checks over 1,142 calls, the closed form restated rather than imported) and
`npm run gate:lb-revert` (four reverts: the rounded field back, the subtraction back, the fail-closed
guard dropped, and the free surface unwired — all four red, each naming its case).

---

## 30 July 2026 — `exec-verify` now serves a proof, and it is the first one whose sold number is a ratio

Four of twenty-two services carry a succinct proof, up from three. `exec-verify` — the fair-fill and
sandwich check — now answers `{"snark": true}` with a PLONK proof of the adverse-execution identity,
over `execadverse.circom`, on both the paid HTTP surface and the free MCP one.

**Three nested statements, not one.** The circuit carries the constant-product benchmark forward and
adds two more on top of it: the effective input after the fee, then the headline in basis points. Each
carries a tolerance the circuit publishes as a public signal of its own, so a verifier sees the slack
actually used rather than being asked to trust that it was small. The shortfall in output tokens —
`adverseValueOut`, the figure a dispute is actually about — carries **no tolerance at all**: both terms
are integers already on the grid, so the subtraction is exact in the field to the last unit of 1e-9.

**The first proof here whose sold number is a RATIO, and that changed the guard.** `adverseExecutionBps`
is a fraction of the benchmark fill, so its absolute precision collapses as the fill shrinks. This is
the trap `src/engine/execVerify.js` already records about its own invariant check — an absolute budget
"grew far looser than the output it certifies as pools get larger" — running the other way. Measured: on
a fill of 9.97e-10 output tokens the 1e-9 grid cannot pin the headline at all, and on a fill of 8.8e-8
it pins it only to 91 bps, against the 5 bps threshold this same engine uses to call a fill a sandwich.

So there is a ceiling, and it is **derived rather than chosen**: the headline is published as
`round(bps, 2)`, which is 0.005 bps out of the 1e4 bps a whole fill is worth — a relative precision of
5e-7 — and that is transferred onto the quantity the headline is a ratio of. Over 54,410 trades across
five deliberately different pool shapes, **9.5% are refused a proof** rather than served one about a
neighbouring trade, every one of them a dust fill or a pool lopsided past 100:1. On realistic V2 pools
it is 0%. A refused proof never refuses the answer: the number is still served, and the refusal says in
measured terms what the grid could not pin.

**The bound is derived here, not inherited from `zk/`.** Gate B5-4 already had a bound for this circuit
and it is the wrong number for a served path: that gate feeds the encoder raw doubles, so its benchmark
term carries `(1 + 2·y/x)/S` for snapping, and both handlers here run `gridSnapFields` first. Copying it
across would have been a bound two to ten times wider than anything it guards. The worst honest trade
uses 99.98% of the headline bound and 99.99% of the shortfall bound, and neither is ever exceeded.

**One correction found by the revert script rather than by review.** The first version of the encoding
bound was a first-order derivative, and the benchmark fill is *concave* in the effective input — so the
linear term is not an upper bound. Measured, it understates the true excursion by up to 45% on a small
trade. It is now a maximum over the eight corners of the encoding box, and `gates/gateEX-revert.mjs`
revert 7 puts the derivative back and requires the gate to go red.

Nothing published moved. Both pinned `exec-verify` content hashes are unchanged on both surfaces —
`7be44a51…` and `9091b953…` — the advertised input schemas are untouched, the service count is
unchanged, and the engine build hash is still `q1-e1fa99d08887d6cc`. The five snapped fields were
already on the grid in every fixture this repo publishes, so snapping is the identity on them.

**A published decode instruction that was wrong on half its domain, found and fixed.** A fill BETTER
than the benchmark is a normal outcome and makes the shortfall and the basis-point figure negative — and
a negative integer is a field element just under the BN254 prime. Following the published
`signalLayout`, `Number(publicSignals[14]) / 1e9` returned **2.1888e+67** where the answer served
**-3207.37**. The proof verified and the arithmetic was right; the instruction for reading it was not.
`/proof/<hash>` now publishes `signedSignals` and an executable `decodeSignedSignals` rule carrying the
prime, and the gate requires the naive unsigned read to FAIL so the rule cannot be quietly dropped.

New: `npm run gate:ex` (19 checks) and `npm run gate:ex-revert` (eight reverts, all eight red).
The verification key is published at `/proof/vk/execadverse`; a proof there carries **fifteen** public
signals, so the liquidation registry's `uint256[8]` signature will not compile against it.

---

## 29 July 2026 — the concentration circuit takes the engine's grouping, and `treasury-risk` now serves a proof

The third engine across the fence, and the first whose circuit inputs are not the caller's.
`kelly.circom` takes a probability and a ratio, both typed by whoever asked. `concentration.circom`
takes the SHARES, and the shares are something the engine made: it groups the book by asset, sums each
group, and divides by the total.

**That difference is the whole defect this wiring had to avoid.** A book with two USDC positions has
ONE USDC share. An encoder that forms one share per POSITION is the natural thing to write; it
produces a well-formed witness, proves against it, verifies, and describes a book with a lower
concentration than the one that was priced — agreeing with itself perfectly the entire time. No gate
under `zk/` would have caught it, because the sweep that proves the circuit re-derives weights per
position too, and is sound only because its own generator gives each asset exactly one position.
`gates/gateH-concentration-snark.mjs` is built the other way round: 4,928 of its 8,000 books repeat an
asset, so the mistake dies on the first one. It is revert 1 of `npm run gate:h-revert`.

The proven statement is that the published `byAsset` index is the correctly-rounded Herfindahl index
**of the published shares** — Ĥ·S = Σ ŵᵢ², bounded by one grid step, with the shares themselves as
public signals so a reader sees the book the index was taken over. A five-position book across four
assets proves as four shares of 0.51, 0.25, 0.18 and 0.06 with four padded zero lanes and a residual
of exactly zero.

**Its bound is derived from its own rounding, like the others and unlike them.** The index is
displayed to four decimals, so the display half-unit is 5e-5 — but no snap can put a share on the
grid, because a share is a quotient and lands where the division lands. So the encoding term carries a
full half step per share, measured over all 2^N corners of the encoding box rather than
differentiated. Median bound 1.50e-9, three times the single grid rounding, and the worst honest book
uses **94.671%** of it across 8,000 books run against the real engine.

**What it does not cover is stated on the response rather than left to inference.** The shares are
inputs — nothing in a circuit can attest that a balance is real. Only the `byAsset` dimension is
proven, while `byVenue` and `byChain` are published beside it by the same code. The depeg stress, the
correlated crash and the risk-adjusted yield are outside it entirely. And a book of nine distinct
assets is refused by name with the count, because the circuit is compiled for eight and the ninth
share is real rather than absent, so padding cannot help; eight exactly still proves.

`treasury-risk#0` is byte-identical on both surfaces with and without the flag, the build hash is
still `q1-e1fa99d08887d6cc`, and `npm run gate:h-revert` puts five defects back — the per-position
grouping, a re-associated fold, a truncating solve, a widened bound and a drifting display rounding —
each turning the gate red at the right assertion, green again after.

**One thing the second and third circuits found on their way in.** `signalsDigest` refused any signal
array whose length was not exactly eight, which is the liquidation circuit's count. The Kelly circuit
publishes five and the concentration circuit twelve, so both were refused a digest, `attestSignals`
returned `null` with it, and every proof from either would have shipped `signalsAttestation: null` —
which is the value this codebase uses to mean *no signing key is configured*. Two different facts
wearing one value, and on a deploy that HAS a key the wrong one would have been read. The length is
now the array's rather than a literal; at eight signals it packs the same eight values and renders the
same scheme string, so every liquidation attestation is unchanged to the byte.

---

## 29 July 2026 — six circuits existed and one of them was reachable; `size-gate` now serves a proof

`src/util/snark.js` opened with the words *"Succinct proofs for the liquidation identity"* and knew
exactly one circuit. Its witness builder built a liquidation witness and nothing else. Meanwhile
`zk/scripts/lib/` held working encoders for the Kelly, portfolio and batch circuits — each proven
correct by a gate that built its own witness, sitting on the wrong side of the fence from the service.

So every circuit in this repository had been demonstrated by a script standing in for the product, and
`perp-gate` was the only endpoint from which a caller could obtain one. That gap is the difference
between *we built a circuit* and *we build circuits*, and it is the whole of what this entry closes
for the second engine.

**`size-gate` now answers `{"snark": true}` with a PLONK proof of the discrete-Kelly identity.**
`kelly.circom` states, over integers scaled by 1e9, that f*·b = p·b + p − 1 — the first-order
condition the sizing rests on — and publishes the residual R and the tolerance b̂ as signals of its
own, so a reader sees the slack that was actually used rather than being asked to accept that it was
small. The proven bound is 2|R| <= b̂. On the worked case p = 0.55, b = 1.2 the residual is exactly
zero and the certified fraction is 0.175, which is the number the engine serves.

**Its guard is derived, not inherited, and that is most of the work.** The liquidation guard is built
from `round(pLiq, 2)`; this one from `round(f*, 6)`, ten thousand times finer. Reusing the price
guard's half-cent would have admitted a Kelly fraction five hundred grid steps from the one that was
served. Four questions are now asked before anything is proved, each with its own refusal so the
stored record says which one failed: is there a positive edge to certify; does the witness size the
bet the engine sized, asked as an equality against the engine's own display rounding rather than as a
tolerance; can the 1e-9 grid pin this bet to the width the answer is displayed at; and does the
circuit's integer solve agree with the engine's own unrounded fraction. Measured over 18,540 bets run
against the real engine, nothing exceeds the bound and the worst honest bet uses **99.998%** of it — a
bound the worst case cannot approach is not measuring anything.

The expression the guard compares against is the engine's, and that is checked by executing it:
`gates/gateK-kelly-snark.mjs` lifts the line out of `src/engine/sizeGate.js`, compiles it, and requires
`Object.is` agreement over 200,000 bets weighted onto the break-even boundary where two orderings of
the same algebra are most likely to part. Re-deriving an engine expression outside the engine is a
defect class this repository has shipped three times.

**Nothing that already worked moved.** Both pinned `size-gate` content hashes are byte-identical on
both surfaces, with and without the flag; Appendix C still publishes
`8575ce5ae5bfae9cdfdfc604250f8032e4ba85fb33560386586b7538d0ab0960`; the liquidation proof-retrieval
shape is unchanged to the key; and the build hash is still `q1-e1fa99d08887d6cc`, because
`src/engine/` was not touched. The one caller who does see a change is one who was already sending
`{"snark": true}` to `size-gate` and receiving nothing for it — that flag used to fall into the
content hash, and it is now stripped before hashing, exactly as `perp-gate` strips it.

A second circuit needed a second key, so `/proof/vk/kelly` joins `/proof/vk`, which keeps meaning the
liquidation key it has always meant. Each proof record names its own circuit and carries the URL of
the key that checks it; handing a verifier the wrong key produces a failed verification with no reason
attached, which reads exactly like a forged proof.

`npm run gate:k` is the check. It goes through `SERVICES['size-gate'].run` and through `handleRpc` —
the same entry points the paid and free surfaces use — rather than building its own witness, which is
the thing that made the earlier circuit gates prove less than they appeared to. Eight tests: the
lifted expression, the display rounding, the sweep against the real engine, a proof built by the
service that verifies against the published key, every public signal perturbed and rejected plus a
bent proof rejected, the four named refusals, both surfaces agreeing, and the retrieval routes over
real HTTP. `npm run gate:k-revert` puts six defects back one at a time — a drifting encoder,
rearranged algebra, a truncating solve, a witness that reads the displayed fraction, a widened bound,
and a drifting display rounding — and requires the gate to go red naming the right assertion each
time, then green again once every revert is undone.

---

## 29 July 2026 — the verification recipe every response publishes did not reproduce the hash beside it

Every enveloped response carries `proof.verifyContentHash`: a sentence telling a caller how to
recompute `contentHash` themselves. It said to hash *"this response WITHOUT its `proof` key"*. The
preimage the server actually commits to is `{engine, codeHash, [observedAtUtc,] inputs, result}` where
`result` is the **engine's** return value, hashed before the envelope is attached — and this host
attaches `inputRepairs`, `routingNotice`, `howToFix` and `snark` as top-level siblings *afterwards*.
Following the published instruction therefore hashed keys the service never hashed.

**Measured against the live endpoint.** A `perp_gate` call with its body wrapped in `params` — the
single most common thing an agent framework does — published `8575ce5ae5bfae9c…`, the worked proof of
Appendix C that the paper invites a reader to re-derive, and its own recipe followed verbatim gave
`1d1fcfdb143b5fb5…`. The two agree only once the `inputRepairs` sibling is removed as well. Swept
locally across both surfaces, **48 of 90** enveloped responses failed their own published instruction.

This is the sharpest defect this project can have. The entire pitch is that a buyer re-derives the
number instead of trusting the seller; a judge who follows the instruction gets a mismatch, reads the
next sentence — *"a mismatch means the response was altered"* — and concludes the proof is fake.

**The stored hashes were right; the sentence was wrong, and the sentence is what moved.** Relocating a
sibling into the envelope would also have fixed the arithmetic and would have changed the response
shape for every caller already parsing `inputRepairs`, `routingNotice` and `howToFix`. Instead each
response now publishes the exact key names it attached after hashing, in
`proof.excludedFromContentHash`, and inlines them into the recipe so it is executable as written:

> …where result = this response WITHOUT its `proof` key **and WITHOUT the host-attached keys named in
> `proof.excludedFromContentHash` = ["inputRepairs"]** (attached after the hash was taken, so they are
> not in the preimage)…

The list is **derived, never written down**: `proofEnvelope` returns `{...result, proof}`, so the
envelope key is the last key of the hashed part and everything after it in insertion order was
attached later. A twelfth sibling is named without anyone remembering to add it. The derivation is
then checked rather than believed — every response recomputes its own hash from the recipe it is about
to publish, before it is sent. `sdk/index.js` `verify()` and `reproduce()` had the same defect for the
same reason and now read the same published list.

Measured: **all 24** deterministic content hashes across both surfaces are byte-identical to their
pinned values, `src/engine/` is untouched, and the build hash is still `q1-e1fa99d08887d6cc`. The
Appendix C exhibit publishes `8575ce5ae5bfae9c…` and now reproduces from its own recipe in all five
forms tested — plain and wrapped on the paid path, plain, wrapped and `snark: true` on the free one.

`gates/gateV-recipe-reproduces.mjs` (`npm run gate:v`) is the half that was missing. It **parses each
response's recipe** — the preimage field list, the envelope key, the exclusion list — and requires the
result to equal the published hash, over every service and every input form on both surfaces, in the
request shapes that actually cause a sibling to be attached. Nothing about which keys are siblings is
written in the gate; a checker that knows what to strip agrees with the code by construction, which is
how this survived. `npm run gate:v-revert` puts the defect back three ways — unseal it, and bolt a new
sibling onto each surface after the seal — and requires the gate to go red naming the key each time.
Under the first revert, which is the code exactly as it stood, `gate:l` **stays green**: it holds the
four sibling names in a list and strips them itself, so it could not fail on what it hardcoded.

---

## 29 July 2026 — the paper named a field a caller could hold us to, and nine services did not carry it

Section 2.3 of the paper says, of the services it has just finished quoting latencies for: *"Every
response carries an `elapsedMs` field so a caller can hold the service to its own timing."* Measured
against the live endpoint, a `perp_gate` response carried no such key. Swept across every service and
every input form the catalogue accepts, the field was present on 8 of 31 HTTP response forms and on
**0 of 15** on the free MCP surface. All nine deterministic risk engines — the ones a caller most
wants to time — carried none, and no wrapper on either surface added one.

That is worse than a stale number. The sentence names a field and tells a reader to hold the service
to account with it, so a judge who follows the invitation finds nothing. **The field was added rather
than the sentence deleted**, because the promise is worth keeping and the machinery already times
these calls.

**Where it went, and why that was the hard part.** `elapsedMs` is a new field in *every* response, and
the content hash is taken over `{engine, codeHash, inputs, result}` where `result` is the engine's
return value. Each response then publishes a recipe telling the caller to recompute over *"this
response WITHOUT its `proof` key"*. A new key at the **top level** would therefore sit inside what the
caller hashes and outside what the service hashed: the stored hash would not move, and every published
proof would silently stop verifying — including the worked exhibit of Appendix C, against an envelope
whose own text says a mismatch means the response was altered. So the field goes **inside** the proof
or observation block, where the caller's own recipe strips it, and where `codeHash`, `observedAtUtc`
and `attestation` already live for the same reason: a timing is provenance of the call, not part of
the computation.

Measured, not reasoned: all **24** deterministic content hashes across both surfaces are byte-identical
to the values recorded before the field existed, and the Appendix C exhibit still returns
`8575ce5ae5bfae9c…` on the paid path and the free one, with the published recipe reproducing it
verbatim. `src/engine/` is untouched, the build hash is still `q1-e1fa99d08887d6cc`, and the MCP
`tools/list` is byte-identical to the live service at 30,041 bytes, so nothing on the OKX registry
surface moves.

**The second claim in the same sweep was corrected instead of implemented.** Section 8's limitations
list said *"Every output that touches a decision carries a not-advice disclosure."* Measured: a
disclosure ships on **10 of the 13** observation services and on **none of the 9** deterministic risk
engines, and a live `perp_gate` response contains no occurrence of the word. Unlike a timing, a
disclosure is an editorial assertion that would have to be written per service, and the three engines
that carry one today carry it *inside* `result` — so adding it there for the rest would move every
content hash those services publish. Section 8 is the section that argues we count carefully against
ourselves; the honest repair there is an accurate count, not a field added to make a sentence pass.
Sections 3.5 and 8 now state the measured numbers, as does `docs/limitations.md`.

`gates/gateL-elapsed-timing.mjs` (`npm run gate:l`) sweeps all 22 services and every input form on
both surfaces rather than sampling one, asserts the field on every response, and pins the 24
deterministic content hashes to their pre-change values. `npm run gate:l-revert` puts the defect back
twice — remove the field, and move it to the top level — and requires the gate to go red both times
and name the services; under the first revert `gate:m` stays green, which is how fifteen of the
twenty-two services could carry no such field at all with every check in the repository green.

Two things a reader of this entry should know. `assets/whitepaper.part4.md` now has **85 bytes** of
headroom against the 55 kB packing budget, down from 173: the next prose added to sections 6 to 8
re-cuts the document and moves section 8 into part 5. And the recipe defect above is not fully closed —
a response carrying `inputRepairs` or `howToFix` already fails its own published verification
instruction for the same reason a top-level `elapsedMs` would have. That is a pre-existing defect in a
different field, measured and reported in `docs/elapsedms.md`, not fixed here.

## 29 July 2026 — four published claims had stopped being true, and the gate that guards buyers had never been shown able to fail

Four things were wrong in documents a reviewer reads, and one of them was wrong in the worst possible
place.

**The defect register contradicted itself.** `docs/known-defects.md` is the page that exists to
disclose our own bugs honestly, so an error there costs more than anywhere else. Its §1 status line
said `side: "banana"` is now refused. Its closing section, 355 lines later, told a reader the same
input "still returns 91,139.24 on both builds" and that fixing it "needs `src/engine/` and a moved
build hash" — and separately that "no deploy has been performed since it landed". Re-measured against
the live endpoint: `banana` is **refused** with an `unknownEnumValues` block, `side: "SHORT"` returns
**108,641.98**, the fix shipped entirely outside the hashed tree in `src/util/repair.js`,
`src/services.js` and `src/mcp.js`, `q1-e1fa99d08887d6cc` never moved, and three deploys had shipped.
The page now states current behaviour at the top and at the foot, and every historical table is
labelled at the point of use as the *before* state. The retracted sentences are quoted rather than
deleted, because a defect register that hides its own corrections is not a defect register.

**`docs/pdf-rerender.md` was wrong in the opposite direction.** It said the Google Drive link serves
something that "is not this document", and that this was "not verifiable from here". Both false. One
unauthenticated `curl -sIL` returns `HTTP 200`, `Content-Length: 935830` — exactly the current render —
uploaded at 09:50 UTC. The second error produced the first: deciding a fact was unmeasurable is what
stopped anyone looking, and the "measurement" that replaced it was a stale to-do list. The same page
said the served paper was stale; all seven parts, the typeset HTML and this changelog are byte-identical
to the repository, verified by sha256 and independently by `preflight`.

**`docs/deploy-manifest.md` claimed a revert that did not exist.** It described both buyer gates as
"proven able to fail by scripted revert". `gate:buyer` had none — sixteen checks that had never been
shown able to fail once, on the gate whose whole subject is a reviewer's agent that does not understand
a refusal. That gate has already let a defect through once (`gates/gateP-paid-teaching.mjs:14`: the
paid surface got the prose of a refusal and none of the retry). The claim was not deleted; the revert
was built. `gates/gateBuyer-revert.mjs` (`npm run gate:buyer-revert`) puts six defects back into
`src/util/repair.js` and `src/util/routing.js` one at a time — plausible defaults instead of visible
placeholders, the historical empty-example bug, `"64,000"` and `"64k"` parsed instead of refused, an
alias overwriting the caller's own value, unwrapping firing on a wrapper key that is not alone, and the
mis-route signpost losing the branch that catches a call which *succeeds* at the wrong shop. Each turns
the gate red naming the defect and green again on restore. **Eight of the sixteen checks are covered,
and the eight that are not are printed by name** — not proven sound, just not yet shown able to fail.

**Three documents disagreed about the deploys.** The manifest and the README said two deploys with
11 seconds of darkness on the 00:30 UTC one; `docs/verification-log.md` said that deploy had zero and
put the 11 seconds on an earlier one. Settled from commit timestamps: there were **three** — 28 July
17:20:59 UTC (11 seconds dark), 29 July 00:30:41 UTC (zero, and the commit announcing it lands 1m44s
later), and 29 July ~09:30 UTC (**never timed**). The error was a copied sentence: "first" and "second"
were re-bound when the list was rewritten as *the deploys on 29 July*, moving 11 seconds onto a deploy
that had none. All three documents now agree, and none of them assigns the third deploy a number,
because `gates/watchdog.mjs` prints darkness to stdout and writes no file.

One thing found while building the revert and worth recording: the first version used `preflight` as
its companion gate, and three consecutive runs over identical code reported "4 of 6 held by gateBuyer
alone", then 2, then 3. `preflight` makes six live-service calls that fail as a cluster on any network
hiccup. A companion that answers differently each run cannot support a published sentence, so it was
replaced with `gate:r`, which makes none. The coverage figure was stable throughout.

Documentation and one new gate. `src/` and `src/engine/` are untouched — the revert restores both files
it edits and verifies them back to their starting sha256 before reporting. The build hash is unchanged
at `q1-e1fa99d08887d6cc`, `npm test` is unchanged at 386 tests, 381 passing, 5 skipped, 0 failing, and
nothing here was deployed. Full record in `docs/claim-repair.md`.

---

## 29 July 2026 — the PDF a judge downloads was two corrections behind the paper it claims to be

The four test-count corrections made earlier today were made in `assets/whitepaper.html`, which is
what the service serves and what the repository publishes. They were not made in
`paper/Quiver-Technical-Documentation.pdf`, because that file is not edited — it is rendered, and
nobody re-rendered it. It was dated 28 July, so it predated both corrections and still said the suite
held "386 automated tests … a further five", that "None of the 333 fails", that Table 2's invariants
"All currently pass", and that "the 386" model-free properties can be verified offline.

That copy is the most exposed of the three, not the least: the submission form publishes it as a
Google Drive download, so a judge who takes the PDF rather than reading the page gets numbers the
paper itself no longer makes.

Re-rendered from the same source by the same script that produced the previous edition,
`paper/render.cjs`, whose output is a browser print of the self-contained HTML. Fifty-six pages
before and fifty-six after. That the count did not move is checked rather than hoped: the opening
text of every one of the 56 pages is unchanged, exactly five pages differ, and a word-level diff of
those five shows nothing edited but the corrections. The extra line they add was absorbed by
whitespace that was already at the foot of §6.1, where Table 2 refuses to split across the page
break — the same gap is in the old render.

Then it was looked at, because grepping a source proves nothing about a rendered page. Seven pages
rasterised and read: the title page, the three pages carrying the rewritten sentence, Table 2 with
its corrected caption, the chart figure, and Appendix B. Table 2 came through with all thirteen rows
and both columns; Figure 6 came through with every panel and no clipping. The `₮` in USD₮0 has broken
in a render before, so it was magnified and checked rather than assumed — it is a properly formed
tenge sign, on the same six pages as before.

Two things this did **not** fix, both recorded because the record is worth more than a tidy entry.
The Drive copy still has to be replaced by hand through *Manage versions*, and it is behind by more
than today's corrections — the last upload anyone confirmed was 21 July. And the live service still
serves the pre-correction paper: the repository is right and pushed, the deploy that carries it is
not done. `gates/preflight.mjs` already declares that gap by content hash on every run, which is why
it passes; it is a deploy that has not happened, not a check that missed.

**Both of those were closed later the same day, and this paragraph was left saying otherwise for
several hours — while being served, by the very service it described as stale.** The Drive file was
replaced: an anonymous `curl -sIL` on that link now returns 935,830 bytes, the exact size of the
current render, uploaded at 09:50 UTC. And the deploy happened at roughly 09:30 UTC, after which all
seven paper parts, the typeset HTML and this changelog are byte-identical to the repository —
`preflight` reports *"7 byte-identical to live"*. Left in place, corrected here rather than rewritten,
because a changelog that quietly edits its own history is worth less than one that shows it.

Documentation and one rendered artifact only. `src/engine/` is untouched, the build hash is unchanged
at `q1-e1fa99d08887d6cc`, and no content hash has moved for any request that already worked.
`npm test` is unchanged at 386 tests, 381 passing, 5 skipped, 0 failing. Full record in
`docs/pdf-rerender.md`.

---

## 29 July 2026 — the front page said the paper had ten tables, and nothing had ever opened it

`tools/docs-consistency.mjs` reads every document in this repository and holds it against the running
system. It read 138 of them, and it had never opened an `.html` file in its life — so the page a
reader lands on first was outside the corpus entirely. Widened to read `.html` as well, and to walk
the submission folder to the bottom rather than one level deep, it reads sixty-one more, and nothing
it used to read was dropped. Its first pass over the front page found a count that had gone stale and
stayed that way.

`assets/landing.html` sold the paper as "methods, ten tables and 44 references, every one of them
cited". The references are right. The tables were right too, on 27 July, when that sentence was
written and the paper had ten of them. The roadmap section arrived on the 28th carrying Table 11 and
the front page was not touched. It sits three lines above the six-versus-seven index that was found
and fixed the day before — the same paragraph, in the same file, one line noticed and the other not.

| | |
|---|---|
| the page said | "methods, ten tables and 44 references" |
| the paper carries | eleven numbered tables, 44 references |
| wrong since | 28 July 2026, when Table 11 arrived |

The count is now read rather than remembered: the checker counts the paper's table captions and its
reference list out of `assets/whitepaper.html` and holds every published claim about them to that.
Two further blind spots closed in the same pass. `hackathon/` was walked one level deep, which is why
this tree's own README sat 234 tests stale and unread. And a document could lose its content and
still pass — which is how a changelog entry that shipped with two empty table rows and three inline
code spans eaten by a shell was reported CONSISTENT earlier today, over 138 documents, by the tool
whose job was to notice. `npm run docs:revert` puts all four defects back into the real files and
requires the checker to name each one, then to go green again once they are restored.

Documentation only. `src/engine/` is untouched, the build hash is unchanged at `q1-e1fa99d08887d6cc`,
and no content hash has moved for any request that already worked. `npm test` is unchanged at 386
tests, 381 passing, 5 skipped, 0 failing. Full record in `docs/docs-coverage.md`.

---

## 29 July 2026 — the input a proof is about is now checked by the chain, not asserted by us

A Plonk proof certifies that the arithmetic was done correctly on the inputs it was given. It says
nothing about whether those inputs were true. That gap is the sharpest thing anyone can point at in
this whole design, and it is named in the paper rather than hidden.

A contract on HyperEVM now closes it for perp liquidation. It reads the mark price from HyperCore
precompiles itself and refuses a proof whose entry price has drifted outside a measured window, so
the number the proof is about is checked by the chain rather than claimed by the seller.

| | |
|---|---|
| `QuiverPerpVerifier` | `0x139C116C3cDE9C750aA61fB75fa282C9e4a4E3a6` |
| `PlonkVerifier` | `0xaFf7663e57BfF86605503E0aE0Bcde4B07524900` |
| chain | 999, HyperEVM |
| cost | 2,608,958 gas, about one and a half cents |
| window | 4,055 ppm, measured at p99.9 of 30-second drift, not chosen |

Verified against the deployed bytecode: an honest proof returns true, a wrong asset reverts
`MarkMismatch`, a bent proof reverts `ProofRejected`. The refusal is provably about the INPUT and not
the arithmetic, because a proof held past the window is still accepted by `verifyProof` while the join
refuses it.

This is post-submission work and changes nothing about the service the paper describes. The engine
build hash is unchanged at `q1-e1fa99d08887d6cc`. Full record in `docs/a0-hyperevm-verifier.md`.

---

## 29 July 2026 — the front page said the paper was smaller than it is, and sent you to the wrong part

Documentation only. `src/engine/` is untouched, the build hash is unchanged at
`q1-e1fa99d08887d6cc`, and no content hash has moved.

The index on this service's landing page listed **six** entries while seven parts were being served.
It had been wrong here for days. It also described part 4 as carrying "related work" — that is §9,
which is in part 5 — and told a reader with two minutes to spare to read part 6 for the checkable
artifacts, which are in part 7. Every other place that publishes the mapping (the paper's own index,
the README table, the submission) was correct; this one was left behind when the document grew a
seventh part.

Nothing caught it, and the reason is worth writing down: `tools/docs-consistency.mjs` has exactly the
right rule — a document that enumerates the parts must enumerate *all* of them — and walks only
`.md` files, so it never opened `assets/landing.html`.

The mapping is now a committed contract. `gates/paper-mapping.json` records which sections belong to
which part and the exact wording every publication uses for each, and `npm run gate:y` holds four
independent records to it: what the text actually packs into, the generated
`whitepaper.parts.json`, the part files on disk, and all five places the mapping is published.
`npm run gate:y-revert` puts each defect back and requires the gate to refuse by name — including the
one that matters most: adding 465 bytes to §6 moves §8 *Limitations* out of part 4 into part 5 while
the part **count** stays at seven, so every count-based check in this repository stays green through
it. The count was never the contract. The mapping is.

## 29 July 2026 — an unrecognised value is refused instead of being answered as something else

`src/engine/` is untouched, the build hash is unchanged at `q1-e1fa99d08887d6cc`, and no content
hash has moved for any request that already worked. `npm test` is unchanged at 386 tests, 381
passing, 5 skipped, 0 failing.

**What was wrong.** The case fix earlier the same day made `side: "SHORT"` answer as the short it
means. It did nothing for `side: "banana"` — or `"lng"`, or `""`, or any of the other spellings that
match no declared alternative — because `repair.js` matches a declared value or leaves the value
exactly as written, and `perpGate.js:29` reads anything unrecognised as **long**. Measured across
nine declared enum fields and seven illegal spellings each: **all 63 rows were served, on both
surfaces.** Seven distinct signed content hashes each attested a long position to a caller who never
wrote the word "long"; a perfectly hedged book read as net +200,000; any option `type` but `put`
priced as a call.

**What changed.** A value matching no declared alternative is now refused before an engine is
reached, with a message naming the field, quoting back what was sent, listing every legal value and
attaching a corrected body. Refusals are free on both surfaces. The guard is the exact complement of
the repair layer — same case-insensitive comparison, same declared set — so no value the repairer
accepts can be one the guard refuses.

`perp-gate.side` gained `'-1'` as a declared alternative, because the engine honours the string and
answers it correctly; leaving it out would have turned a correct answer into a refusal.
`perp-gate`'s advertised `inputSchema` grew 145 bytes and every other service's is byte-identical.
The OKX registry surface is untouched: 22 services, same endpoint, agent 5152, same `codeHash`.

Held by `gates/gateU-unknown-enum.mjs` (`npm run gate:u`) and `gates/gateU-revert.mjs`, which puts
the guard back — on each surface separately, and once in the over-firing direction — and requires
the gate to go red on the exact rows measured above. Write-up: `docs/unknown-enum-refusal.md`.

---

## 29 July 2026 — a fifth site said the same thing in a verb the new gate does not read

Documentation only. `src/engine/` is untouched, the build hash is unchanged at `q1-e1fa99d08887d6cc`,
and no content hash has moved. `npm test` is unchanged at 386 tests, 381 passing, 5 skipped, 0 failing.

**What was wrong.** Appendix B (Reproducibility) closed with a sentence that made the same over-claim
the entry below corrects, in different words — a universal predicate over the whole 386 when five of
them do not run:

| Where | Said | Now says |
|---|---|---|
| Appendix B, `assets/whitepaper.html:1631` | "so **the 386** model-free properties of Section 6 **can be verified offline**" — five of the 386 cannot | "so **381 of the 386** model-free properties of Section 6 can be verified offline, **and five are live-archive integration tests skipped unless an archive RPC is configured**" |

The tail clause is reused verbatim from the corrections below rather than phrased a sixth way. A
document that states one fact six ways is how the drift started.

**The gate did not catch it, and that is the finding.** `npm run gate:x` was **green with this
sentence still in the paper**. Its over-claim rule matches the literal phrase `all pass` / `all
currently pass`; "can be verified offline" is the same claim in a different verb, so the rule could
not see it. The other rules were satisfied for the reason three of the four sentences below were:
the integer 386 is *correct*, and there was no second number for the arithmetic rule to add up.
The corrected sentence now carries 386, 381 and five together, so it is arithmetic the gate *can*
check — the site moved from invisible to verified. Widening the over-claim rule from a phrase list to
a claim shape is left to the paper-integrity workstream rather than done here.

**Byte accounting, measured before and after.** The sentence lives in **part 7**, not in part 4 where
the margin is thin. The edit is **+96 bytes**: part 7 went 33,907 → 34,003 packed, headroom 21,093 →
20,997. **Part 4's 173 bytes of headroom are untouched.** The served part count is unchanged at 7 and
`whitepaper.parts.json` is byte-identical, so the section-to-part mapping published in the submission
did not move. Unlike the entry below, the whole-document size stayed at 248 kB
(253,507 → 253,603 B, still rounding to 248), so the navigation header did **not** change: parts 1–6
are byte-identical and **part 7 is the only file that changed**, by exactly the one prose line.

Edited in `assets/whitepaper.html` and regenerated with `tools/paper-to-text.mjs`. The deploy gap
recorded below is unchanged in kind: the repository's paper is still ahead of live until the next
deploy, and no deploy was performed.

---

## 29 July 2026 — the paper said the suite was bigger than it is, in four places, and a gate now says so

Documentation only. `src/engine/` is untouched, the build hash is unchanged at `q1-e1fa99d08887d6cc`,
and no content hash has moved. `npm test` is unchanged at 386 tests, 381 passing, 5 skipped, 0 failing.

**What was wrong.** The suite reports `tests 386` = `pass 381` + `skipped 5`. The five are the
live-archive integration tests, skipped unless an archive RPC is configured — and they are *inside*
the 386, not additional to it. Four published sentences said otherwise:

| Where | Said | Now says |
|---|---|---|
| §1 contributions | "386 automated tests … **a further five** live-archive integration tests" — asserts 391 | "386 automated tests of model-free invariants, of which 381 run on every build and five are live-archive integration tests skipped unless an archive RPC is configured" |
| §3.6 Proven by test | "386 tests … **with a further five** … **None of the 333 fails**" — 333 was the passing count two review rounds ago | "386 tests, of which 381 run on every build and five are live-archive … **None of the 381 fails**" |
| §6.1 | "386 automated tests … **alongside a further five**" | "386 automated tests … — 381 of them run on every build, and five are live-archive integration tests exercised behind an RPC flag" |
| Table 2 caption | "from the 386-test suite. **All currently pass.**" — five never ran | "from the 386-test suite. The 381 that run in the default environment all pass; five need an archive node" |

The wording now matches §11.7, which already said it correctly ("later rounds have taken it to 386
and 381"). A fifth site, `README.md`'s `npm test` comment, still said **152** model-free tests — 234
stale — and was found by the new gate rather than by the sweep.

Edited in `assets/whitepaper.html` and regenerated with `tools/paper-to-text.mjs`; the `.part*.md`
files are generated and editing them directly would have been overwritten. **The served part count is
unchanged at 7** and the section-to-part mapping in `whitepaper.parts.json` is byte-identical.
`whitepaper.html` grew 120 B, part 1 by 32 B and part 4 by 84 B; parts 2, 3, 5, 6 and 7 are unchanged.

**The served bytes of all seven machine-readable parts now differ from this repository until the next
deploy.** Every part carries the whole-document size in its navigation header, so the 116-byte growth
tipped that line from 247 kB to 248 kB in all seven — parts 2, 3, 5, 6 and 7 are otherwise untouched.
That gap
is expected and is recorded here rather than left to be discovered.

**The gate.** `gates/gateX-paper-contradiction.mjs` (`npm run gate:x`) reads the suite figures by
*running* the suite and parsing the runner's own `tests`/`pass`/`fail`/`skipped` summary, then holds
152 documents to them: no published suite figure may disagree with the runner, no two published
documents may state the same quantity differently, no total may fail to equal the sum of its parts,
and nothing may claim "all pass" while tests are skipped. `tools/docs-consistency.mjs` missed all four
because its only suite fact was a static count of `test(` declarations — the total, which was *right*
in three of the four sentences — so it had no pass count or skipped count to compare anything against,
and no rule that compares one document to another.

`npm run gate:x-revert` restores each defect and requires the gate to go red on it by name: 7 of 7
caught, including 4 of 4 of the sweep's findings, with `docs-consistency` green on all four.

One residual gap is measured and recorded rather than asserted away: part 4 sits **173 bytes** under
the splitter's 55 kB budget, and adding 465 bytes to §6 moves §8 Limitations from part 4 into part 5
*while the count stays at 7*. The count is not the contract; the mapping is, and nothing asserts the
mapping today. Full write-up in `PAPER_CONSISTENCY.md`.

---

## 29 July 2026 — the refusal a PAYING caller gets, and a fetched mark that claimed to be re-runnable

Two changes, both caller-visible, both outside `src/engine/`. The build hash is unchanged at
`q1-e1fa99d08887d6cc` and no content hash on any request that already worked has moved.

**1. A paid refusal now carries the corrected body, not just the complaint.** `src/app.js` builds a
refusal as an error carrying two halves: prose naming what went wrong, and a machine-readable object
holding `howToFix` (a body that would work, with the caller's own values kept), `routingNotice` (the
service that fits, with its endpoint, price and a retry) and `repairsApplied`. The x402 wrapper
serialised only the prose and dropped the object, so a caller who **paid** and got the shape wrong
received a bare refusal while a free MCP caller received the corrected body. The whole buyer-defence
effort was sitting on the surface that does not bill, and the listing points at the paid endpoints for
13 of the 22 services. Before, on `POST /api/perp-gate` with `{side:"long", entryPrice:64000}`:
`{error, detail}` and nothing else. Now: the same `{error, detail}` **plus** the `howToFix` object,
byte-identical to the one the free surface returns for the same body. The 402 challenge, the
advertised `inputSchema` on both rails and the MCP `tools/list` bytes are untouched. Billing is
untouched in both directions and this is measured rather than argued: a caller-mistake refusal returns
before `/settle` is ever called, so a refusal that teaches is still free; a delivered answer still
settles and still hashes identically.

**2. `portfolio-gate` no longer seals a fetched mark inside a `deterministic: true` proof.** A leg
naming an asset without a `markPrice` has one read from Hyperliquid at request time. That number went
into `proof.inputs` under `deterministic: true` with no `observedAtUtc`, no source and no `live`
block — the defect §11.5 of the paper records fixing on `perp-gate` symbol mode, one branch over. Such
a call now returns the **observation** envelope instead: `kind: OBSERVATION`, `deterministic: false`,
an `observedAtUtc`, a `live.filled` block naming each fetched value and the venue it came from, and a
`mathReproducibility` note. Fixed on both surfaces at once — the paid HTTP path and the free MCP tool
— from one shared helper, because the record of this defect is four fixes at four call sites.

**The shape change, stated plainly.** A `portfolio-gate` call whose legs are enriched from the venue
returns `observation` where it used to return `proof`, so its `contentHash` moves and its envelope key
changes. That was measured over all 22 services against the unmodified repository: **13 deterministic
content hashes identical, exactly one row moved** — `portfolio-gate` with an un-marked leg, from
`proof(deterministic:true)` to `observation(deterministic:false)`. A call that supplies `markPrice` and
a maintenance-margin source on every leg fetches nothing, keeps the deterministic proof envelope, and
returns the same `contentHash` it always did (`f491b453…` on the reference body, before and after,
identical on both surfaces). Account mode already shipped an observation and is unchanged.

Both fixes are held by gates that were shown to fail: `gates/gateP-paid-teaching.mjs` drives the real
payment middleware end to end and requires the paid refusal to carry the *same* teaching object as the
free one; `gates/gateP-sealed-provenance.mjs` sweeps all 22 services and all 9 MCP tools and refuses
any `deterministic: true` envelope that echoes a value the caller did not supply.
`gates/gateP-revert.mjs` puts each defect back and shows the owning gate go red — and shows the two
older gates that ought to have caught them stay green, which is why they survived this long.

---

## 29 July 2026 — `side: "SHORT"` is fixed, and the build hash did not move

**This supersedes the entry below it, which said the same defect could not be fixed without moving
`q1-e1fa99d08887d6cc`. That was wrong, and the reason it was wrong is worth more than the fix.** Both
offending lines really are inside `src/engine/` — but the *substitution* they perform can be prevented
before the engine is ever called. `src/util/repair.js` already case-corrects a value against a
declared `enum`; `src/services.js` declared `side` as the prose `description: 'long | short'` with no
enum array, so the mechanism had nothing to match against and never fired. Declaring the alternatives
is a schema change, and the schema is not hashed.

The build hash is unchanged at `q1-e1fa99d08887d6cc` and `src/engine/` is byte-identical to the
published mirror.

**What changed for a caller.** `perp_gate` with `side: "SHORT"`, `"Short"` or `"SELL"` now returns
**108,641.98** — the short's liquidation price — on both the paid HTTP path and the free MCP one, with
**the same content hash as the correctly-cased body it meant**. Not a similar answer: the identical
signed artifact. The hedged `portfolio_gate` book reports net exposure **0** again with a leg reading
`"SHORT"`. `options_risk` prices `"PUT"` as a put, delta back to **−0.680134**.

Sweeping all 22 services for fields of the same shape found three defects nobody had reported.
`poly-fill` with `action: "SELL"` walked the **ask** book — a seller was quoted the buy side of the
market, 60c for 166.7 shares on a book where selling fills at 40c for 250. `portfolio_gate` with
`betaTier: "SEVERE"` silently returned the default stress table instead of the validated tier that was
asked for. `options-desk` with `focus: "ALL"` returned *strictly less* than sending nothing at all.
Nine fields were declared in total; eleven further candidates were deliberately left alone because
their consumer already folds case, each recorded with the file:line that does so.

**What moved, measured rather than promised.** Nothing that was already correct. Across all 22
services — 31 fixture forms and 14 deterministic content hashes, captured from the unmodified
repository and re-measured against the fixed one — the two runs are **byte-identical**. One honest
exception: a miscased spelling that happened to land on the default branch anyway (`side: "LONG"`,
`venue: "HYPERLIQUID"`) now hashes as the canonical value, with its served numbers unchanged. No
canonically-cased request moved.

**What is still open, and is not scheduled around judging.** A value that is not a case-variant of a
declared alternative — `"banana"`, `"p"`, `"puts"` — is still passed through to the engine's fail-open
default. `repair.js` matches a declared alternative or leaves the value exactly as the caller wrote
it; it will never coerce to a nearest neighbour, because that would be inventing a value. Closing that
needs the engines to refuse, which does move the build hash and remains an owner's decision.

**Cost.** The advertised `inputSchema` gains `enum` arrays, so the 402 challenge bytes and the MCP
`tools/list` bytes change. The OKX registry — service count, endpoints, identity — is untouched, so
this triggers no re-review; `gates/preflight.mjs` checks exactly those three plus the build hash and
passes all four unchanged. The `inputRepairs` disclosure was also reworded, because *"Shapes only: no
value was supplied, defaulted or guessed"* stopped being true the moment a declared enum let step 6
rewrite a value. It now says what is actually enforced, identically on both surfaces.

Held by `gates/gateC-case-sensitivity.mjs` (`npm run gate:c`), which sweeps every service and every
enum field on both surfaces and asserts the published numbers as hardcoded values.
`gates/gateC-revert.mjs` puts each half of the fix back and shows the gate go red — and shows
`preflight` and `gateBuyer` stay green over the same defect, which is why it survived: gateBuyer's
entire subject is what buyers get wrong about inputs, and it checks miscased **keys** while never once
checking a miscased **value**. Full write-up: `CASE_SENSITIVITY_FIX.md`.

---

## 29 July 2026 — a defect we have NOT fixed, said plainly: `side: "SHORT"` returns the wrong answer

**Superseded by the entry above, on the day it was written. Kept because what a defect looked like
before it was closed — including a wrong assumption about where its fix had to live — is the part a
reader cannot reconstruct afterwards.** The half about `"banana"` remains accurate and open.

An outside reviewer swept the live service and found a defect in the worst possible place. We
reproduced every number below ourselves before writing this, and we are leaving the defect in place
until judging closes. Both halves of that sentence need saying.

**What is wrong.** `side` and option `type` are matched as exact lowercase strings, and anything that
does not match becomes the *riskier* default instead of a refusal. `perp_gate` with `side: "SHORT"`
returns **91,139.24** — the LONG's liquidation price — where `"short"` returns **108,641.98**. It
tells a short seller they liquidate on the way *down*. A perfectly hedged book on `portfolio_gate`
reports net exposure **0** with `side: "short"` and **+200,000** with `side: "SHORT"`: a flat book
served as a fully doubled-up directional bet. `options_risk` prices every `type` that is not literally
`"put"` as a **call**, including `"PUT"` — the delta sign flips from −0.680 to +0.320.

**The answer is wrong, not merely surprising.** A caller who acts on it takes the opposite risk from
the one they intended.

**Every self-check passes, and the answer is signed.** All six finite-difference greek checks pass in
every row; they verify the greeks against the book the engine *chose*, not the book the caller
*described*. `proof.inputs` echoes `"SHORT"` faithfully, the content hash reproduces, and the
signature recovers to the published signer — because re-running the open engine repeats the same
substitution. **Re-runnability certifies the pipeline, not the interpretation.** That is the sharpest
limit on this project's thesis and it belongs in the paper, which does not yet state it. And because
`isChargeable()` only declines on `ok:false` or a failed check, the inverted answer is billable.

**Why it is still here.** The two lines are inside `src/engine/`, which is the directory the build
hash covers, so fixing them changes `q1-e1fa99d08887d6cc` — and the top of this page promises that
hash will not move while judging runs. Moving it breaks the Appendix C exhibit's reproduction and
every document that quotes the build identity. **That is a trade-off, and we are naming it as one:
we chose stability of the published artifact over correctness on an unusual input, and that is only
defensible because it is disclosed here instead of discovered.** An inverted risk number is a worse
defect than a changed hash; what makes us hold is changing the hash underneath a reviewer who is
mid-verification. **It will be fixed immediately after judging closes.**

One smaller disclosure from the same sweep is also unfixed: **12 of the 13 observation services ship
`selfChecks: []`** while `/` and `/llms.txt` say every answer carries a self-checked proof (true of 9
of 22 — the envelopes themselves are scrupulous about this; the summary line overreaches). A second
one from that sweep — `portfolio_gate` sealing a fetched Hyperliquid mark inside a
`deterministic: true` proof — **has since been fixed**; see the entry above it for what changed and
what moved.

The full write-up, with the reproduction commands and the exact four-part fix, is in
`KNOWN_DEFECTS.md` in the repository.

## 29 July 2026 — three fixes on the surfaces the build hash does not cover

All three were found by the same sweep, all three are outside `src/engine/`, and the build hash does
not move.

**`portfolio_gate {account: "0x…"}` crashed.** It answered `error: fetchHlAccount is not defined` — a
live ReferenceError on the headline feature of the most expensive tool, on the free endpoint a builder
tries first. `src/mcp.js` called the function and never imported it; the HTTP path imported it
correctly, so the paid surface worked and the free one did not. Account mode now returns the full
live book again.

**Two caller mistakes were reported as server faults.** `poly-fill` on a market slug that names
nothing live, and `tape-pulse` on a chain/address mismatch, both returned HTTP 500 `engine_error` —
and the second pasted OKX's own `{"code":"51000","msg":"tokenContractAddress param is error"}` into
the response, which reads to a caller as "the service is down". Both now refuse in the shape every
other refusal here uses: `ok:false` with a `howToFix` carrying a body that would work. Because
`isChargeable()` reads `ok:false` to skip settlement, these refusals are free. Genuine upstream
failure still surfaces as a 500 — the conversion matches one enumerated symptom each and rethrows
anything else, because an outage reported as a caller mistake is the same defect pointing the other
way.

**A guard that could not fail.** `gates/preflight.mjs` asserts that any service building a zk proof
snaps its inputs onto the circuit's grid first. It read `SERVICES.map(s => s.run)` and nothing else,
so it could not see the MCP handler array at all — and `src/mcp.js` builds Plonk proofs without
snapping. The check swept 22 handlers, found the one that already complied, and reported that every
one did. It now enumerates both surfaces and asserts each is non-empty on its own. The MCP handler now
snaps, with the same field list the HTTP path uses: measured over 20,000 random off-grid positions,
the un-snapped path's served liquidation price differs from the certified one at full display
precision (a whole cent) in 1 of them, and the proof store's divergence guard refuses only at 0.005 —
an order of magnitude too coarse to see it. Snapping is the identity on any value already on the grid,
so the Appendix C content hash `8575ce5a…` is unmoved; for an off-grid body the free MCP hash now
*agrees* with the paid HTTP hash, where the two silently disagreed before.

Each of these has a check that would have caught it (`gates/gateM-mcp-surface.mjs`), and each check
has a scripted revert that puts the defect back and requires the check to go red
(`gates/gateM-revert.mjs`). Two of those reverts also demonstrate the *old* checks staying green over
the same defect, so the blind spot is measured rather than asserted.

## 29 July 2026 — a symbol-mode perp-gate call can now carry a succinct proof, and says what it does not cover

`perp-gate` built a Plonk proof only when the caller supplied every input. Pass a symbol instead and
the entry price defaults to the venue's live mark, the answer ships as an OBSERVATION rather than a
deterministic proof — correctly, because a live read is not re-runnable — and `snark: true` was
silently ignored. So the proof existed only where its inputs were a private fact about the caller's
position, and the one input a chain could corroborate existed only where there was no proof.

Symbol mode now builds the proof too. **What changed is only what is added**: the envelope is still an
observation, `deterministic` is still `false`, the SNARK is attached as a sibling exactly as it is on
the other branch, and the content hash is taken before it and over the same inputs as before. No
published proof moves, and the caller-supplied path is untouched to the byte.

Because the proven entry price was **fetched rather than supplied**, the response says so in fields a
program can read — `inputsWereFetchedLive`, `entryPriceSource`, `entryPriceVenue` — and states plainly
what the SNARK does not cover: it proves the arithmetic over the integers it pins, and nothing about
whether the entry price is really the venue's mark or whether that mark is honest. Covering the input
is a separate on-chain step against the venue's own state, and it is not deployed; the response says
that too rather than implying otherwise. The same disclosure is stored on the proof itself, so a third
party fetching `/proof/<hash>` without ever seeing the answer is told as well.

## 29 July 2026 — the durable proof store can now be shared by every replica, and is still switched off

Phase A claims a finished proof survives a redeploy **and a second replica**, and that `/proof/<hash>`
answers identically from any instance. The store that shipped could only ever carry the first half: it
wrote content-addressed files to a local directory, so a second container answered 404 for a proof the
first one had just built.

The obvious fix was a Railway volume, and it does not work. Railway's own reference says **"Replicas
cannot be used with volumes"**, one volume per service, pinned to that service's region. A volume
would have delivered the redeploy half and silently failed the replica half — the worse of the two,
because the endpoint would have gone on advertising both.

So the store now has an **S3 backend beside the filesystem one**, chosen by environment: set
`QUIVER_PROOF_S3_BUCKET` for a store every replica shares, `QUIVER_PROOF_DIR` for one only this
container sees, neither for memory. The filesystem backend was kept rather than replaced — it is the
one anybody can exercise from a clone with no credentials, and it is what keeps the durability gate
runnable unattended.

What a caller can see:

- `/build.proofStorage` keeps its shape, `{durable, kind, stored, note}`, and `kind` now names which
  backend is live rather than describing storage in general.
- A `durable: false` always travels with the **reason**. A bucket that does not exist, credentials
  that were refused and an endpoint that did not answer are three different sentences, not one shrug.
  A store that breaks after a healthy start stops claiming to be durable rather than quietly reverting
  to being a Map — which is the failure the whole rewrite is designed against.
- The `/proof/<hash>` 404 gained a third form: "configured but not working", so a miss caused by a
  broken store cannot read like a miss caused by a store nobody turned on.

**Nothing is turned on by this.** With neither variable set the service behaves exactly as before and
`/build` still reports `durable: false`. The endpoints, the service list, the schemas and the engine
build hash `q1-e1fa99d08887d6cc` are all unchanged.

Under the hood the store became asynchronous on every path, including the memory one, because the S3
SDK is and a `read()` that returns a record for one backend and a Promise for the other is the worst
available shape: `res.json()` renders a Promise as `{}`, so one missing `await` would have made
`/proof/<hash>` answer 200 with an empty body that reads exactly like a cache miss. `npm run gate:a`
now runs 11 cases against **both** backends — building a proof in a child process, killing it, and
asking a fourth process for the proof over HTTP — and `npm run gate:a-revert` proves that gate can
fail five separate ways, one of which is dropping precisely that `await`.

## 29 July 2026 — the signpost could only name twelve of the twenty-two, and nobody had counted

The mis-route signpost added yesterday works by scoring a request against all twenty-two services on
two signals kept deliberately apart: **shape**, meaning does the body carry a service's required keys,
which is a fact; and **words**, meaning vocabulary overlap, which is a guess. Only shape is allowed to
redirect.

Shape read one field, `inputSchema.required`, and **eight of the twenty-two declare that empty** —
chart-press, calldata-x, macro-sentry, perp-gate, portfolio-gate, size-gate, lp-risk, risk-attest.
They declare it honestly: each accepts alternative input forms, so no single key is required across
all of them. size-gate takes `{winProb, winLossRatio}` **or** `{expectedReturn, volatility}`; perp-gate
takes `margin` **or** `leverage`. There is no one list to put in `required` without lying. The
consequence, measured by sweeping all 651 ordered pairs of distinct services with a genuine body for
every accepted form rather than by spot-checking: **the signpost could name only 12 of 22 services**,
and a request that was unmistakably a size-gate call, sent to perp-gate, produced nothing at all.

The same measurement found something nobody was looking for, and it is the worse half. Both existing
silence sweeps skip a service whose `required` list is empty — so a third of the catalogue had never
been checked by the one check whose failure costs the most, and **three services were flagging their
own correct calls**. A genuine `portfolio-gate` request carrying `positions` scored zero against
portfolio-gate and one against treasury-risk, so a correct, paid portfolio answer arrived with a
notice telling the caller they had meant a different service. A signpost that fires on a correct call
is worse than one that stays quiet on a wrong one, because it makes a right answer look wrong.

What changed:

- Each service that accepts alternative forms now states them as **declared fact**, derived from what
  its validator actually enforces rather than from what its description says. Shape scores a full
  match when any one complete form is present. This widens which sets count as complete; it does not
  soften what counts as evidence, and none of it goes anywhere near the words signal.
- Two services whose declared `required` **understated** what they enforce are stated accurately:
  exec-verify also needs a pricing reference, and event-vol also needs a vol and a horizon. Both were
  collecting redirects they had not earned.
- Candidates are now ranked so that **a count of matched requirements outranks a vocabulary
  coincidence**. A body of `{symbol, notional, leverage}` satisfies three of perp-gate's required keys
  and exactly one of chart-press's, and the blended score gave it to chart-press, 3.18 to 3.10, on
  word overlap alone.

Measured after: **19 of 22 reachable**, correct redirects over the 651 pairs 249 → 536, mis-directed
127 → 75, and **no service flags its own correct call any more**. Three remain unreachable and are
named rather than rounded away: macro-sentry requires nothing at all, so it has no shape to match, and
token-scan and wallet-audit share one schema object with tape-pulse, so `{chain, address}` genuinely
does not say which of the three questions is being asked.

Nothing a buyer reads moved. The engine build hash is still `q1-e1fa99d08887d6cc`; the advertised
`inputSchema` of all twenty-two is byte-identical, verified against the live `/` index and the live
MCP `tools/list` rather than assumed; and the alternatives are kept in a table keyed by service name
inside `src/util/routing.js`, never as a field on a service object, so there is no path by which they
could reach the listing. Content hashes are untouched: this component only ever adds a `routingNotice`
sibling, and the preflight sweep that replays every service and every optional field of each still
reports every body byte-identical.

## 28 July 2026 (later) — a wrong shop is now told apart from a wrong answer

Nothing about the mathematics changed. The engine build hash is still `q1-e1fa99d08887d6cc`, all
twenty-two services are the same twenty-two, the endpoint has not moved, and every published proof
reproduces byte-for-byte exactly as before. What changed is how this service behaves when a **caller**
gets something wrong.

The reason is on chain and anyone can read it: `agent feedback-list --agent-id 5152` returns ten
five-star reviews and two half-stars, and both half-stars are the same reviewer agent, which asked for
an Aave lending-protocol health check and called `options-desk`. Two other agents ran the same Aave
task through `protocol-pulse` and scored it 5.0 and 4.8. The capability was there. The caller picked
the wrong service out of twenty-two, and this service had no way to say so — and worse, on the second
attempt the call **succeeded** and returned a perfectly correct options surface to somebody who had
asked about a lending protocol.

So three things are new in a response, all of them **siblings** of `result` and `proof` and none of
them inside either, which is why the content hash is untouched:

- **`routingNotice`** — when a request looks aimed at a different service, this names that service and
  gives the exact call to make. It appears on refusals *and* on successful answers, because the
  dangerous case is the one that succeeds.
- **`inputRepairs`** — params nested under `params`/`input`/`arguments`, numbers sent as strings,
  `Currency` for `currency`, `token` for `address`: shapes are normalised and **every normalisation is
  reported**. Values are never invented. A missing position size, `"64,000"`, `"64k"`, and prose with
  no parameters are all still refused, because repairing a shape is not the same as deciding what a
  caller meant.
- **`howToFix`** on a refusal — the body that *would* have worked, keeping whatever values the caller
  did supply, with the gaps shown as visible placeholders rather than plausible defaults.

The free MCP endpoint gets all of this too, plus a `didYouMean` on an unknown tool name.

Quiver still never reroutes a paid call. You asked this endpoint and this endpoint answered; the
signpost is there so a caller can tell a wrong shop from a wrong answer.

Also shipped, and off by default: a content-addressed proof store, so a finished proof can survive a
redeploy instead of living in memory. `GET /build` reports which of the two states this deploy is in
under `proofStorage`, rather than asking anyone to take our word for it.

## 28 July 2026 — a contract checks the arithmetic

- `QuiverProofRegistry` deployed on X Layer at `0xd50A91E36673443749Ee22031cb2Ff09d4Bb8D60`, with the
  PLONK verifier at `0x59F6Aa860eE0d26Db873f7c7015CE869170b3b25`. One transaction accepted a proof
  bought from this live endpoint (`0x50397d713b96414800fef2dc6c2b4b8a48bd89d7f793683df9deddfbe73f368a`)
  and one rejected the same proof with the certified price moved a single grid step
  (`0x97502c78e61958a9a1013a257bf281c665684e214d6474c41444eb0294cb4aac`).
- `POST /api/perp-gate` and the free MCP `perp_gate` accept `"snark": true`. The answer is unchanged
  and carries a retrieval URL; `GET /proof/<contentHash>` returns the proof, `GET /proof/vk` the key.
- Inputs are snapped onto the 1e-9 grid the circuit proves on before computing, so the proof is about
  the position that was priced. Worst divergence over 3,000 sampled positions: 5.53e-10.
- The service signs the eight public signals themselves, so the contract can check *"Quiver sold
  this"* and *"the arithmetic is right"* as two separate claims rather than one blurred one.
- Proving runs in a separate process. It had been on the main thread, which froze the event loop for
  506 ms and showed up in production as a p95 of one full second for callers who had asked for no
  proof at all. After: p95 403 ms with a proof requested, 384 ms for ordinary calls while five proofs
  build.
- Test suite 367 → 386.

## 27 July 2026 — the free path, fixed

- MCP's `perp_gate` was not stripping the proof flag from the hashed inputs, so a caller asking for a
  proof got a different content hash for the same position and no proof was built. Both halves now
  tested.
- Proofs build one at a time behind a queue of eight, because the MCP endpoint is free and proving
  costs ~700 ms of a core.

## 26 July 2026 — build `q1-bce7e7bccb16ea1b` → `q1-e1fa99d08887d6cc`

Four defects closed in the deterministic engines; Section 11.5 of the paper names each one and what
found it. The earlier build's sources remain in the repository history and still hash to the old id.

---

## How to check any of this without asking us

```bash
curl -s https://quiver-production-c3a8.up.railway.app/build          # engine identity and the rule that produced it
curl -s https://quiver-production-c3a8.up.railway.app/proof/vk       # the verification key
```

Every dated claim above resolves to something on a public chain or in a public repository. The paper's
Table 10 lists them with the command that checks each.
