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
