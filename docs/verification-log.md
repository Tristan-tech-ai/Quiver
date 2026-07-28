# Verification log, autonomous run of 28 July 2026

Round 1 of the loop. Verifications run first because they decide which research is worth doing and
which tasks are real. Each entry says what was measured, not what was concluded from reading.

## V3 — the Deribit payload objection: CONFIRMED WRONG BY A FACTOR OF TEN

`PHASE_D_RESEARCH.md` calls the 373 KB option chain "seven times any published zkTLS benchmark". A
later pass said the wire form is about 37 KB under gzip. Measured with `curl`, which reports bytes on
the wire rather than after decoding:

| request | wire bytes |
|---|---|
| `accept-encoding: identity` | **373,210** |
| `accept-encoding: gzip` | **37,377** |

HTTP compresses before TLS encrypts, so an MPC-TLS cost model pays for the compressed stream. The
"seven times any benchmark" claim is retracted.

**My own first probe of this was wrong and is worth recording.** I measured with Node's `fetch` and
`arrayBuffer()`, which reported 372,321 bytes for BOTH requests, and would have led me to conclude the
server was not compressing at all. Node's fetch decompresses transparently, so `arrayBuffer()` returns
the decoded size whatever the encoding. The `content-encoding: gzip` header was right there in the
response and I read past it. Anything measuring payload size through a client that auto-decompresses
is measuring the wrong number.

## V5 — `gate:e` is genuinely flaky, 1 run in 3

Three consecutive runs: **14/15, 15/15, 15/15.**

It hits live RPCs, so this is not a regression and not a code defect. It matters for one reason: an
"everything green" deploy gate cannot rest on a check that fails a third of the time by chance. Any
future claim that all gates are green has to say which of them are deterministic and which are not.

`gate:e` is not in the deploy set, so it does not block. Recorded so nobody treats a single red as a
finding.

## V1, V2, V4 — delegated, running

- **V1**: two prior agents disagree about whether Hyperliquid's hourly funding formula reproduces the
  published rate, 10,752/10,752 against 61/156. Being settled by running both side by side.
- **V2**: whether an IBC light client of dYdX on another Cosmos chain can supply the independent
  checkpoint the attestation currently lacks. Decides whether that workstream is ordinary engineering.
- **V4**: building the DefiLlama reconstruction gate PER RESERVE, because comparing on the total
  produces a verifier that cannot fail: at a 10 bps aggregate band, 32 of 57 reserves could be zeroed
  and it would still read green.

---

## Post-deploy round

## V6 — `gate:d3` instability is the data source, not the code

Observed 15/1 then 10/6 on consecutive runs shortly after two agents edited the same adapter, which
looked exactly like a merge defect. Re-run three times after the deploy: **0 failures, 0 failures, 0
failures.**

So the gate is correct and its dependency is not. It reads live dYdX archives whose depth and
availability vary by the minute, and one of the two archive-serving operators is the only one deep
enough for the historical path.

**This is a real weakness in the gate rather than a curiosity.** A check whose red can mean either
"the thing under test is broken" or "somebody else's server was busy" cannot be read as a binary. The
codebase already has the right pattern in two places: `gate-clone-portability` separates a missing
npm package from a broken path, and the `eth_getProof` work splits rate-limit HTML from a real
verification failure and retries only the former. `gate:d3` should do the same, and until it does,
its red is not evidence on its own.

**RESOLVED, right after the deploy landed.** The gate now splits the two meanings apart. An allowlist
of transport signatures (refused connections, 502/503/504, aborts, `height not available`, pruned
archives) goes to an `unavailable` bucket; **everything else counts as a real failure**, so an error
nobody anticipated lands on the strict side instead of being quietly excused. Written the other way
round, as a list of strings meaning "broken", the first unfamiliar error would be forgiven and the
gate would go silent exactly when something new went wrong.

And the half that nearly got missed: forgiving unreachable archives is precisely how a verifier stops
being able to fail, because if every market were unreachable the failure list would be empty and the
test would report success having proven nothing. So the verdict now rests on a coverage floor that
refuses to report any verdict at all below 90% of attempted attestations, and says so in those words
rather than pretending attestation is broken.

**Both halves were proven able to fail rather than asserted.** The classifier is tested in both
directions, and one of its cases is an unrecognised message that must NOT be forgiven, so a
classifier returning true for everything fails the test. The floor was proven load-bearing by a
scripted revert: force every market to throw a transport error, which leaves the OLD assertion
passing vacuously, and only the floor catches it, reporting `NOT ENOUGH COVERAGE TO CONCLUDE
ANYTHING: 0 of ~120`. **Without that floor this fix would have made the gate strictly worse than the
flaky version it replaced.**

Gate now 17 of 17 with 0 failures, twice over. Full suite unchanged at 386 tests, 381 pass, 0 fail,
matching the numbers taken at deploy time. `gates/` sits outside `src/engine/`, so the codeHash does
not move and no re-review is triggered; the live service was re-checked mid-work and still serves
`q1-e1fa99d08887d6cc`.

## The deploy, for the record

Went out at 17:20:59 UTC, 01:20 WITA, inside the agreed window.

| | |
|---|---|
| dark | **11 seconds**, against a three-minute expectation |
| services | 22, unchanged |
| MCP tools | 9, unchanged |
| paid path | 402, correct |
| codeHash | `q1-e1fa99d08887d6cc`, unmoved, so no re-review |
| changelog | matches the repo and carries the day's entry |
| paper parts | 7/7 byte-identical |

The one doubt named before pressing was `gate:d3`'s instability. It was resolved rather than waived:
no attestation module is reachable from any served path, so the instability could not touch a request.
V6 above now confirms the instability was never a defect at all.

`proofStorage` reports itself `durable: false` with the instruction to set `QUIVER_PROOF_DIR`. That is
correct: Phase A shipped switched off, pending a decision about a Railway volume.

## V8 — the OKX listing read fresh, and the one-star fear did not come true

Read from the registry itself rather than from any note: `agent service-list --agent-id 5152`, at
07:25 WITA on 29 July, hours after the deploy.

| | |
|---|---|
| services listed | **22 of 22**, `total: 22` |
| every endpoint | points at `quiver-production-c3a8.up.railway.app`, matching the live service |
| `approvalStatus` | 4 |
| `onlineStatus` / `status` | 1 / 1 |
| `securityRate` | **4.33** |
| `salesCount` | 1,761 |
| name and description | unchanged, so no re-review was triggered by anything done today |

**The rating is 4.33, not one star.** The reviewer whose agent handed out a one-star without reading
the input contract did not sink the listing, and the buyer defence shipped today exists so the next
one has to work harder to be wrong: an unknown MCP tool name now answers with the full list of nine,
and a mis-routed body gets told which service it actually wanted.

Two things noted and NOT resolved, because guessing at them would be worse than leaving them open:

- `QUIVER_MISSION_CONTROL.md` records `soldCount 19` where the API now returns `salesCount 1761`.
  Those may be different counters rather than the same one having moved, and the field names differ.
  Not reconciled here.
- 1,761 sales against the 315 inbound transfers measured on X Layer over 140,000 blocks. The usage
  measurement counted value actually arriving at the payTo address; `salesCount` is OKX's own
  lifetime counter and may include free, trial or MCP traffic that moves no money. **The trickle
  conclusion rests on the on-chain count, which is the stricter of the two**, so the widening circuit
  is still being built for single digits. But the gap is real and unexplained.

## V7 — `portfolio-gate` not snapping its inputs is a non-issue, and the reason is worth keeping

Reported as a defect: `perp-gate` snaps its inputs onto the 1e-9 grid at `services.js:313` and
`portfolio-gate` never does. It was left unfixed on the grounds that snapping would move contentHashes.

That reasoning was never tested. **Exactly one service builds a Plonk proof, `perp-gate`, and it
snaps.** `portfolio-gate` returns a `proofEnvelope`, which is the ordinary signed-response wrapper
nearly every service uses and is not a zk proof at all. `zk/circuits/portfoliogate.circom` is a proven
identity gated under `zk/` and reaches no served path. So no buyer can receive a portfolio-gate proof,
and there is no unsnapped-input proof failure to have. Nothing to fix, and the contentHash worry was
about a change that was never needed.

**The first attempt at this named the wrong service.** It concluded `risk-attest` on the strength of a
probe matching `/zk|plonk|proof/` against each live service entry. That probe was reading prose:
`risk-attest`'s description says "batch proof content-hashes into one Merkle root", so it matched on a
word, while `perp-gate`'s says "proves it correct" and did not. The check caught it on its first run.

Left as three checks in `gates/preflight.mjs` rather than a note in a document, because the gap between
"true today" and "required the moment anyone wires a second proof in" is exactly where a fact rots into
a wrong assumption. They read the handler functions themselves rather than sweeping the source file, so
moving code between files cannot make them quietly stop matching.

**Preflight and not `test/`, for two reasons.** This invariant belongs to deploy time, and preflight is
the one thing that always runs before `railway up`; a gate in `gates/` with its own npm script is a gate
that stops being run, which already happened here once. And the served whitepaper quotes the suite size
in twelve places, so four new test cases would have made the live paper disagree with the repo, with the
deploy window closed and no way to reconcile them.

Both proven able to fail. Strip the snapping and "every service that builds a zk proof snaps its inputs
onto that grid first" goes red; blank the handler bodies and the vacuity guard reports `NOTHING MATCHED
across 22 handlers — this check proved nothing` rather than passing over an empty set. Preflight now 14
checks, 13 passing, the one red being its refusal to pass without a changelog entry for a NEXT deploy,
which is the gate working. Suite unchanged at 386 tests, 381 pass, 0 fail.
