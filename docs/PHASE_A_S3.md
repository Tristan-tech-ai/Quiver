# Phase A over S3 — the durable proof store, and exactly what is proven

*29 July 2026. Written against build `q1-e1fa99d08887d6cc`. Nothing here is deployed.*

Phase A of the roadmap claims that a finished proof **survives a redeploy and a second replica**, and
that `/proof/<hash>` answers identically from any instance. The store that shipped could not carry
that claim: it wrote content-addressed files to a local directory, so a second container answered 404
for a proof the first container had just built. It was also switched off in production, and said so
out loud — `/build.proofStorage` reported `durable: false`.

This is the object-storage backend that can carry the claim, built beside the filesystem one rather
than replacing it, with the gate extended to cover both.

---

## 1. The Railway premise, checked rather than inherited

The brief for this work asserted that a Railway volume attaches to one instance and is therefore
unable to carry the replica half of the claim. That assertion is the entire reason S3 was chosen, so
it was verified against Railway's own documentation before any code was written. It holds, and it is
stricter than the phrasing suggests.

| question | Railway's answer | source |
|---|---|---|
| One volume, more than one replica? | "Replicas cannot be used with volumes" | `docs.railway.com/volumes/reference` |
| Volumes per service? | "Each service can only have a single volume" | `docs.railway.com/volumes/reference` |
| Attached to more than one service? | "A volume can be attached to one service." | `docs.railway.com/infrastructure-as-code/reference` |
| Survives a redeploy? | yes — but "we prevent multiple deployments from being active", so a redeploy takes downtime | `docs.railway.com/volumes/reference` |
| Region? | "Volumes follow the region of the service to which they are attached." | `docs.railway.com/deployments/regions` |

Two honest qualifications. First, Railway documents the prohibition as a flat rule and describes the
*attach* direction (the attach-volume option is hidden while replicas is greater than one); it does not
publish what happens if you scale up a service that already has a volume. Second — and this matters
for how this document should be read — **Railway nowhere says "use object storage instead".** They
ship S3-compatible Buckets and describe them as "true object storage, not block storage like Volumes",
but they draw no line between that and horizontal scaling. The inference is ours. What is *cited* is
only the constraint.

A third fact worth recording because it closes off the obvious workaround: shared volumes is an
explicitly declined feature request on Railway's own feedback board, and the changelog carries no
entry adding multi-attach through July 2026. This is a current constraint, not stale documentation.

**So: a Railway volume would give us the redeploy half and silently fail the replica half.** That is
the worse of the two failures, because the endpoint would go on advertising both.

---

## 2. What was built

`src/util/proofStore.js`, rewritten. Same job, same content-addressed naming, two backends chosen by
environment:

| environment | backend | `kind` reported by `/build` |
|---|---|---|
| `QUIVER_PROOF_S3_BUCKET` set | S3, or any S3-compatible endpoint | `content-addressed objects in S3` |
| `QUIVER_PROOF_DIR` set | a directory on this container | `content-addressed files` |
| neither | memory only — unchanged behaviour | `in-memory only` |

S3 wins if both are set, because an operator who has both has almost certainly just added the bucket
and not yet removed the old path, and quietly preferring the disk would put the proofs on the volume
that is about to be thrown away.

**The filesystem backend was not deleted and is not deprecated.** It is the one a clone can exercise
with no credentials, no network and no container, which is what makes the gate runnable unattended by
anyone. Losing it would mean losing the only durability check a stranger can run.

### The published shape did not move

`/build.proofStorage` still reports exactly `{durable, kind, stored, note}` — the gate asserts on the
sorted key list, so a fifth field cannot be added by accident. What changed is that `kind` now names
which of the three backends is live, and that a `false` always travels with the reason:

```
{"durable":false,"kind":"content-addressed objects in S3","stored":0,
 "note":"Durable storage is CONFIGURED BUT NOT WORKING, so proofs are held in memory and cleared by
         a redeploy: s3://quiver-proofs/proofs/ is unusable: NoSuchBucket (HTTP 404): The specified
         bucket does not exist — the bucket does not exist at this endpoint/region"}
```

A bare `durable: false` from a misconfigured bucket would be indistinguishable from a deploy that
never turned durability on. That is the failure this whole rebuild is designed against, so it is
asserted at the endpoint and not only in the store.

---

## 3. The async cascade, and the trap it created

The S3 SDK is asynchronous and the old `read()` was not. The dangerous middle ground — a `read()` that
returns a record for one backend and a Promise for the other — was refused outright. **Every function
in the store is now async on every path, including the memory-only one**, so a caller who forgets to
await gets a Promise every single time and fails on the first run, instead of intermittently on the
one deploy that has a bucket configured.

The specific hazard is worth naming because it is silent: `res.json(promise)` serialises a Promise as
`{}`. A `/proof/<hash>` route missing one `await` would answer **HTTP 200 with an empty body**, which
a client reads as "the proof exists and has no signals" — strictly worse than a 404.

Every call site was traced and changed deliberately:

| file | change |
|---|---|
| `src/util/snark.js` | `getProof()` is async; `buildInBackground()` is async and holds a claim across its first await so two requests for one hash cannot both enqueue a proof; a new `flushProofWrites()` settles the prove queue and then the in-flight writes |
| `src/app.js` | `/build` and `/proof/:contentHash` are async handlers; the 404 note gained a third branch for "configured but not working" |
| `src/server.js` | drains writes on SIGTERM, bounded at five seconds — with a network store a proof is `ready` in memory some milliseconds before it exists anywhere a second process can see it, and a redeploy is a SIGTERM |
| `test/snarkBindsTheServedAnswer.test.mjs` | four `getProof` calls awaited. **No test case added or removed** |

The gate proves the trap is caught rather than merely avoided: one of its five scripted reverts is
exactly "drop the await in the route", and it turns the endpoint assertions red.

---

## 4. What an operator must set

Turning it on is entirely environment. No code change, no endpoint change, no price change.

```
QUIVER_PROOF_S3_BUCKET=quiver-proofs     # required — this is the switch
QUIVER_PROOF_S3_REGION=eu-west-2         # optional; falls back to AWS_REGION, then us-east-1
QUIVER_PROOF_S3_PREFIX=proofs/           # optional; default proofs/ — a trailing slash is added for you
QUIVER_PROOF_S3_ENDPOINT=                # optional; only for a non-AWS S3 (MinIO, R2, Railway Buckets)
```

Credentials come from the AWS SDK's own provider chain — `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`,
a shared profile, or an IAM role. **Quiver deliberately defines no credential variables of its own**;
inventing them would force an operator to hold a long-lived static key when a role would do.

Tuning knobs, all with working defaults: `QUIVER_PROOF_MAX` (500, how many proofs to keep),
`QUIVER_PROOF_S3_TIMEOUT_MS` (8000), `QUIVER_PROOF_S3_RETRY_MS` (15000, how long a known-bad
configuration is believed before it is re-probed), `QUIVER_PROOF_S3_MAX_ATTEMPTS` (3),
`QUIVER_PROOF_COUNT_TTL_MS` (15000, how long the object count behind `/build` is cached).

The IAM policy needs `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject` and `s3:ListBucket` on the
prefix. Note that the health probe is a **write** (`PutObject` of a fixed key, then a best-effort
delete) and not a `HeadBucket`: `HeadBucket` requires `s3:ListBucket` at the bucket level, so probing
with it would report a perfectly working least-privilege store as broken. The probe tests the exact
permission the store actually uses. A policy that grants `PutObject` but not `DeleteObject` still
works; it just leaves one stray object, overwritten on every boot.

**Cost per proof:** one `PutObject` and one `ListObjectsV2` (the listing is capped at
`QUIVER_PROOF_MAX + 1` keys and doubles as the count refresh, so the common case is two calls and no
extra listing for `/build`). Deletes happen only when the cap is exceeded.

---

## 5. What is proven, and against what

There are no AWS credentials on the machine this was built on, and none were created. **Nothing here
has been run against Amazon S3.** Two things were run against instead, and they cover different halves:

| | in-process emulator (`gates/s3-emulator.mjs`) | MinIO in Docker |
|---|---|---|
| runs with no setup at all | yes — this is the default for `npm run gate:a` | no, needs a container |
| SDK wiring, command usage, XML parsing | yes | yes |
| cross-process durability | yes (objects live in the runner, not in either child) | yes (objects live outside every Node process) |
| SigV4 signing and credential handling | **no — it serves any signature** | **yes** |
| error shapes for 404 / 403 / unreachable | yes, injected | yes, genuine |
| IAM policy evaluation | no | no (MinIO root user) |

Both were run, and the gate prints which one it used. Set `QUIVER_TEST_S3_ENDPOINT` (plus
`QUIVER_TEST_S3_BUCKET` and credentials) to point it at a real server; leave it unset and it uses the
emulator. **11 of 11 cases pass in both configurations.**

### What could still differ on real AWS, honestly

- **IAM denials.** A real policy can deny `s3:ListBucket` while allowing the object verbs, or scope a
  condition to a prefix. MinIO ran as root and the emulator checks nothing, so no policy evaluation
  has been exercised at all. The failure would surface as `AccessDenied` on the listing inside
  `prune()` — which is swallowed by design, so pruning would stop silently while writes kept working.
  That is the one place the design deliberately prefers keeping the proof over keeping the bound.
- **Consistency on overwrite.** S3 has been read-after-write consistent for new objects and overwrites
  since December 2020, which is why there is no temp-and-rename on the S3 path (`PutObject` is atomic
  for the whole object). This store never overwrites with different content anyway — a content hash
  has exactly one correct answer — so the exposure is small, but the claim is inherited from AWS's
  documentation rather than measured.
- **Regional latency.** Everything measured here is loopback: sub-millisecond. A real bucket adds
  10–100 ms per operation depending on placement. That does not touch the request path (proving is
  already off it) but it does set how long the SIGTERM drain needs, and the five-second bound in
  `src/server.js` is a guess that has never met a real round trip.
- **Throttling.** `503 SlowDown` under load has not been produced. The SDK retries three times by
  default; beyond that the store would report itself not durable with the reason, which is the correct
  behaviour but has not been observed.
- **Bucket-level surprises**: object lock, requester-pays, a bucket policy denying unencrypted PUTs,
  KMS on a key the role cannot use. Each would arrive as a named error and be reported, but none has
  been seen.

### Error shapes actually measured

Against MinIO, from a real process, with the message the endpoint would publish:

| condition | reported |
|---|---|
| bucket does not exist | `NoSuchBucket (HTTP 404) … — the bucket does not exist at this endpoint/region` |
| credentials rejected | `InvalidAccessKeyId (HTTP 403) … — credentials were rejected, or the policy does not grant s3:PutObject on this prefix` |
| endpoint unreachable | `Error: connect ECONNREFUSED 127.0.0.1:9099 — the endpoint could not be reached` |

In all three, `durable()` is `false`, `read()` is `null`, `write()` is `false`, and both `/build` and
the `/proof/<hash>` 404 body carry the sentence.

---

## 6. The gate

`npm run gate:a` — 11 cases, roughly nine seconds. It spawns real child processes: one builds a real
Plonk proof and **exits**, a second and unrelated process reads it back, a third with no store
configured must *not* find it, and a fourth boots the whole service and is asked for
`/proof/<hash>` over HTTP. Every case runs against both backends with the same assertions.

The service-in-a-child case is the one that earns its keep. Asserting on what the store returns cannot
see a missing `await`; asserting on the bytes the route serves can.

`npm run gate:a-revert` — **five** scripted reverts, each removing one thing and naming which
assertion should notice. Full output:

```
  REVERT: writes are a no-op
          gate against reverted code : 4 pass, 7 fail
            ✖ [filesystem] a proof outlives the process that built it, and the endpoint serves it
            ✖ [filesystem] only finished proofs are persisted, and a damaged record reads as a miss
            ✖ [filesystem] the durable store stays bounded
            ✖ [s3] a proof outlives the process that built it, and the endpoint serves it
            ✖ [s3] only finished proofs are persisted, and a damaged record reads as a miss
            ✖ [s3] the durable store stays bounded
            ✖ a store that breaks AFTER it was healthy stops claiming to be durable

  REVERT: the durable read is gone from getProof
          gate against reverted code : 9 pass, 2 fail
            ✖ [filesystem] a proof outlives the process that built it, and the endpoint serves it
            ✖ [s3] a proof outlives the process that built it, and the endpoint serves it

  REVERT: durability is claimed rather than checked
          gate against reverted code : 8 pass, 3 fail
            ✖ an unwritable directory reports itself off rather than pretending
            ✖ a bucket that does not exist is a NAMED refusal, not a silent miss
            ✖ a store that breaks AFTER it was healthy stops claiming to be durable

  REVERT: the /proof endpoint forgets to await the store
          gate against reverted code : 8 pass, 3 fail
            ✖ [filesystem] a proof outlives the process that built it, and the endpoint serves it
            ✖ [s3] a proof outlives the process that built it, and the endpoint serves it
            ✖ a bucket that does not exist is a NAMED refusal, not a silent miss

  REVERT: a failed S3 write is swallowed
          gate against reverted code : 10 pass, 1 fail
            ✖ a store that breaks AFTER it was healthy stops claiming to be durable

  gate against restored code : 11 pass, 0 fail
GATE A REVERT: PASSED — the durability gate is capable of failing, five ways
```

Each revert turns red *only* the cases that depend on what it removed, which is the part that makes
the reverts evidence rather than decoration.

### The gate is staying in `gates/`

The file's own comment used to say it would move into `test/` "when the durable store ships". It says
the opposite now, and gives the reason. The paper is served live at `/paper/1` … `/paper/7`, is
byte-identical to the copy in this repo, and states the size of the model-free suite in roughly two
dozen places. Moving these cases into `test/` moves that number in the repo while the live paper keeps
the old one, and nothing can reconcile the two except re-cutting and redeploying the paper — to
describe a feature that is switched off. So the gate stays where the checks that spawn processes, bind
sockets and talk to networks already live, wired into `package.json`, with a revert that proves it can
fail.

---

## 7. What did not move

Checked, not assumed:

| | before | after |
|---|---|---|
| engine `codeHash` | `q1-e1fa99d08887d6cc` | `q1-e1fa99d08887d6cc` |
| engine file count | 37 | 37 |
| suite size | 386 | 386 (381 pass, 5 skipped, 0 fail) |
| paper parts, byte-identical to live | 7 of 7 | 7 of 7 |
| service count | 22 | 22 |
| Appendix C `contentHash` | `8575ce5a…0960` | `8575ce5a…0960` |
| `/build.proofStorage` keys | `durable, kind, stored, note` | `durable, kind, stored, note` |

`src/engine/` was not touched. The hash rule walks `src/engine` recursively and hashes only `*.js`
under that root; `src/util/` is not under it, which is why a store rewrite cannot move the build hash —
and `/build` reports the file list alongside the hash, so that is checkable rather than asserted.

`node gates/preflight.mjs` replays every service and every optional field through the repair layer and
requires a byte-identical echo, because a rewritten request body moves the contentHash and breaks
published proofs. It passes. So does `node tools/docs-consistency.mjs`.

## 8. The dependency

`@aws-sdk/client-s3@3.1097.0` — **25 packages, 3,269 files, 7.4 MB of content** across `@aws-sdk/` and
`@smithy/`. Measured, not estimated, and the two numbers people quote differ: `du -sb` (what a layer
carries) says 7.4 MB, `du -sh` on this filesystem says 14 MB, because 3,269 mostly-small files at 4 kB
block granularity waste more than half their allocation. The layer figure is the one that matters for
an image rebuilt on every deploy.

That cost is paid at install time regardless, which is why the client is additionally **imported
lazily**: a deploy with no bucket configured never loads any of it into the process. If the package
were missing entirely the store says so by name rather than throwing on the first proof.

A hand-rolled SigV4 signer over `node:crypto` would be about a hundred lines and no dependency, and
was considered. It was not taken: the five operations here include `ListObjectsV2` pagination and
`DeleteObjects` XML, and a bespoke signer is exactly the kind of code that works against one
implementation and fails against another — which is the failure this store exists to not have.

## 9. What is not done

- **Not deployed.** No `railway up` was run. The service was deployed at 00:30 UTC today and there is
  no open window; this lands in the repo ready for one.
- **No bucket exists.** Turning this on needs someone to create a bucket and grant a role, which is a
  decision with a cost attached, not a code change.
- **The five-second SIGTERM drain is a guess.** It has never met a real round trip.
- **Multi-replica has not been observed**, only made possible. Two replicas sharing one bucket is the
  claim; what has been tested is two *processes* sharing one bucket, which is the same mechanism and
  not the same demonstration.
