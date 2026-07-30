# A transient refusal was memoised, so "retry shortly" was unretryable

**30 July 2026.** `src/util/snark.js` answers `GET /proof/<hash>` out of a 200-entry in-memory Map. When the
8-deep proving queue was full it wrote this record and returned:

```
unavailable — prover busy — 8 proofs already queued; retry shortly
```

That record satisfied the guard every proof builder opens with, so the **identical** request never rebuilt —
not when the prover went idle, not ever, until the entry fell out of the cache. The sentence told the caller
to retry and retrying did nothing.

`src/util/proofStore.js` already had the opposite policy in writing, for the durable layer, and had had it
longer: it refuses to persist `failed`/`unavailable` because *"a refusal is a judgement made by one build of
the code. Persisting it would let a fixed prover keep serving the old refusal after a deploy. Cheap to
redo."* The in-memory guard contradicted the store it writes through.

---

## 1. Reproduced first, behaviourally, before any code moved

Driving the served `event-vol` handler — `SERVICES[].run`, not a builder called directly — with
`snark: true`, memory-only proof store:

| step | what was done | what the store said |
| --- | --- | --- |
| saturate | 12 distinct bodies with `snark: true` | **8** admitted (`building`), **4** refused `prover busy` |
| 1 | one further body, `spot: 61234.5` → `ca935a5b…` | `unavailable — prover busy — 8 proofs already queued; retry shortly`, at `07:29:28.311Z` |
| 2 | the **identical** body again, still busy | same status, **same `at`** — no rebuild |
| 3 | wait for the prover to go **completely idle** (**12.2 s**), then the identical body again | `unavailable — prover busy`, **`at` still `07:29:28.311Z`** |

Step 3 is the defect: nothing was in the prover, the queue was empty, and the request that would have been
admitted was answered out of a cache holding a statement about a moment that had passed. The handler's own
`snark.status` said `building` and published a `retrieveAt` URL while the store held `unavailable`.

The same script against the fixed file: step 2 re-derives and re-refuses (correctly — the prover really is
busy, and the `at` moves by 12 ms), and step 3 returns **`ready`** after **12.3 s** of idling. The content
hash `ca935a5b…` did not move at any point.

## 2. Seven guards, not six

`snark.js`'s own header comment said "the six builders below", and so does the changelog entry that closed the
adjacent in-flight defect. Counted: the guard occurs **seven** times, in `buildInBackground`,
`buildKellyInBackground`, `buildConcentrationInBackground`, `buildExecInBackground`, `buildNcdfInBackground`,
`buildLpBracketInBackground` and `buildOptionsRiskNcdfInBackground` — the seventh, `options-risk`, was wired
earlier the same day. All seven are patched, the comment is corrected, and `gates/gateMR-revert.mjs` asserts
the literal occurs **exactly seven** times before it will run at all.

This document names functions rather than line numbers, because every line number in this file has moved at
least once today.

## 3. The change

`store.has(contentHash)` treats every record in the cache as a settled answer. It is now a question about
what the record actually says:

```js
function answeredOrInFlight(contentHash) {
  const rec = store.get(contentHash);
  return !!rec && (rec.status === 'ready' || rec.status === 'building');
}
```

**A positive list, not `status !== 'unavailable' && status !== 'failed'`.** A status added tomorrow is then
retryable by default. The two failure directions are not symmetric: re-deriving a refusal costs the
arithmetic of one witness — every refusal in the file is written *before* the queue is touched, so a
re-attempt cannot occupy the prover — while memoising a status that should have been retried costs a caller
a proof they were told to retry for.

**`building` still blocks, and that is load-bearing.** `claimed` is released when a build is *enqueued*, not
when it settles, so from enqueue to `ready` the `building` record is the only marker that a hash is in the
prover. Dropping it re-opens the defect `gates/gateIF-inflight-eviction.mjs` was written for. **`ready` still
blocks** too: proving is 703 ms of a core and a repeat must keep costing nothing.

## 4. The permanent half, measured rather than assumed

`unavailable` is two things wearing one status. Besides `prover busy` it carries **permanent** refusals — the
display ceilings, the encoders' witness reasons — and making those retryable is only safe if re-deriving one
is idempotent and cheap. Three, each reached through a served handler:

| permanent refusal | pinned hash | re-attempts | re-derivation cost, over three runs |
| --- | --- | --- | --- |
| perp-gate display ceiling (`cannot pin this position tighter than ±0.5000000010001279`) | `9f76337c…` | **1** distinct sentence, status never left `unavailable` | **0.015 – 0.057 ms/call** |
| exec-verify dust fill (`cannot pin this benchmark fill`) | `5b1fe700…` | **1** distinct sentence | **0.019 – 0.049 ms/call** |
| lp-risk breakeven ceiling (`cannot pin this breakeven`) | `02080b7c…` | **1** distinct sentence | **0.687 – 1.406 ms/call** |

Three runs: two of the gate at 50 re-attempts per body, and one standalone script at 200. The cost column is
the *marginal* cost — the same body's per-call time with `snark: true` minus its per-call time without, so it
is what the re-derivation adds and not what the request costs. The lp-risk case is the expensive one because
its witness replays the engine's 200-halving bisection, and even there the marginal cost is **less than the
cost of answering the request at all**: in the 200-repeat run, 0.687 ms/call against the 1.687 ms/call the
same body costs with no proof requested.

**And they are not masked.** With 8 proofs in the prover, all three permanently refused bodies still get
their own sentence rather than `prover busy`. That ordering is what makes the retry safe to advertise: a
caller told "retry shortly" for a proof that can never exist would retry forever.

**Nothing leaks.** After 150 re-attempts of permanently refused bodies plus a full saturation round, an
honest request still proved: `ready`, not `prover busy`.

## 5. What checks it, and how it is known to be able to fail

`gates/gateMR-memoised-refusal.mjs` — `npm run gate:mr` — **10 checks, all behavioural**, driving
`SERVICES[].run` (paid HTTP) **and** `TOOLS[].run` (free MCP, the surface that has been the forgotten site
four times) and reading the real store through `getProof`. Nothing in it reads source: a textual probe for
`observationEnvelope` in this repository once reported 22 of 22 services and was wrong.

* **MR.0** proves one fixture on a prover nothing has touched yet — MR.9's subject, and a floor of its own.
* **MR.1 / MR.4 — the floors.** Saturation is asserted first on each surface: exactly `MAX_QUEUED` = 8 of 12
  legs admitted, the remaining 4 carrying the transient sentence, and the target's *first* attempt refused.
  Without these, "the retry rebuilt" would pass on a process where nothing was ever refused. Both floors are
  green under every revert below, which is what makes them a floor rather than a restatement.
* **MR.2** an in-flight build is not overwritten by a repeat of its own request.
* **MR.3 / MR.5** ★ once the prover is idle the identical request rebuilds, on HTTP and on MCP. MR.3 also
  reconstructs the served field from the rebuilt record: `2·61234.5·(2·573350375126/2⁴⁰ − 1) = 5256.156…` →
  `5256.16`, which is what the response published.
* **MR.6** a permanent refusal keeps its own sentence with the queue full.
* **MR.7** a permanent refusal re-derives to one sentence and is cheap (the table above is its output).
* **MR.8** re-attempting refusals never occupies the prover.
* **MR.9** a `ready` proof is never rebuilt, on a fixture it proves itself.

Three mechanical traps were hit while writing it, and all three are recorded in the file because any one of
them would have made it lie:

1. **A poll that reads the wrong record.** "Poll until not `building`" returns *immediately* for a memoised
   refusal, before the retry's builder has had its first microtask — so the check reported the old refusal
   for a retry that did rebuild. What is waited for is the **rewrite** (`at` changes), which is also the
   better behavioural statement.
2. **A floor that fails for the wrong reason.** `queued--` runs one turn *after* the `ready` record a poller
   sees, so a round started the instant the previous one settled had **7** legs admitted instead of 8 — a
   false red about the service rather than a defect in it.
3. **Two cascades, both caught by the revert script rather than by reading the gate.** MR.9 first read round
   one's target, so it went red whenever MR.3 did; then it proved its own fixture at the end, so it went red
   whenever a revert filled the queue. Neither was a finding. It now proves its fixture in MR.0, before
   anything else has touched the prover, and each revert below turns exactly the checks it owns red.

`gates/gateMR-revert.mjs` — `npm run gate:mr-revert` — puts a defect back **five** ways and requires gate MR
to go red each time, **naming** the case, with a named companion that **stays green** so the failure is
attributable:

| revert | goes red | stays green |
| --- | --- | --- |
| `store.has` back, in all seven guards | MR.3 *and* MR.5 (one per surface) | MR.2 |
| an in-flight build no longer blocks (`building` dropped) | MR.2 | MR.3 |
| a finished proof no longer blocks (`ready` dropped) | MR.9 | MR.3 |
| a refusal that leaks a queue slot (`queued++` before the ceiling refusal) | MR.8 | MR.7 |
| the transient check moved to the top of `buildOnce` | MR.6 | MR.7 |

Result: **5 of 5 reverts turned gate MR red**, each naming its own case, and the gate returned to 10 pass /
0 fail on restore. The revert script also asserts each literal occurs **exactly** the expected number of
times before it writes anything — seven for the guard — because a revert that patched one of seven and
reported green would be worse than no revert at all.

The fourth revert is worth naming as a *new* hazard rather than an old one: a refusal that leaks a queue slot
was harmless while refusals were memoised, because it could only fire once per hash. Retryable refusals make
it reachable 150 times in a row, so MR.8 exists because of this change and not before it.

## 6. What did not move

* **`src/engine/` untouched** — `diff -r` over the whole directory against the mirror is empty, `git status`
  on it is empty, and its 37 files still hash to **`q1-e1fa99d08887d6cc`**.
* **No contentHash moved and no response shape changed.** `npm test` is unchanged at **386** (381 pass, 5
  skipped, 0 fail) before and after. `gates/gateV-recipe-reproduces.mjs` green; Appendix C still reproduces
  at `8575ce5a…`. `gates/gateIF-inflight-eviction.mjs` green, 5 of 5.
* **The paper was not touched.** `node tools/docs-consistency.mjs` and `node gates/preflight.mjs` green.

The one caller-visible thing that *does* move is the point: a repeated request whose stored record is a
refusal now re-derives it, so the record's `at` stamp advances and a transient refusal can become `building`
and then `ready`. `assets/changelog.md` carries the dated entry.

## 7. Still open

* **The handler still reports `status: 'building'` optimistically.** Both surfaces write
  `status: w.reason ? 'unavailable' : 'building'` into the response *before* the builder has reached the
  queue, so a response can say `building` and publish a `retrieveAt` URL for a request whose stored record
  turns out to be `prover busy` a microtask later. That is pre-existing, it is what makes MR.1 possible to
  write, and it is not what this fix is about — but a caller reading the response body alone cannot tell a
  queued proof from a refused one. Left alone deliberately: changing it would change a response field.
* **`gates/gateLP-bracket-snark.mjs` and `gates/gateLP-revert.mjs` have no `npm run` alias in either tree.**
  Both files are tracked and committed; `grep -c gate:lp` is **0** in both `package.json` files. A clone has
  the gate and no name to run it by. Not folded into this commit — it is another session's file to name — and
  recorded here rather than left for the next reader to rediscover. (The neighbouring `gate:lb` gap this
  document originally reported was real when it was measured and was closed by another session's commit while
  this was being written; it is stated in the past tense here because it was re-measured, not because it was
  assumed.)
* **This tree has five live sessions and the changelog entry for this work was committed by one of them.**
  Commit `1e270d9`, whose subject is an unrelated revert-harness fix, carries `assets/changelog.md` with
  **104** inserted lines: its own entry and this one. That is how a repository comes to describe a fix it does
  not contain, and it is the reason the code below was committed immediately afterwards rather than at the end
  of a review pass. Nothing was lost and nothing needed rewriting — the entry it swept up is the entry that
  belongs there — but a wholesale `git add` of a shared file is how the "committed a file that imports a module
  nobody committed" defect happened on 29 July, and it just happened again in a milder form.
