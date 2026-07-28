# V2 — The trusted checkpoint for dYdX attestation: MEASURED, AND IT EXISTS

**Verdict: an independent checkpoint is obtainable today. The dYdX light-client workstream is UNBLOCKED for live
attestation and CONSTRAINED (not blocked) for historical attestation — and the binding constraint is not IBC, it is
dYdX RPC state pruning.**

All numbers below were measured live against public endpoints on **2026-07-28, 14:2x–14:4x UTC**, with dYdX mainnet at
height ~99,353,650. Nothing here is recalled or assumed. Where a number is derived rather than read, it says so.
Reproduction commands are in the last section.

---

## 0. The one-line answer

`osmosis-1` (and four other chains) stores, on chain, validated by its own validators, a record whose contents include
**the exact dYdX `app_hash`** that every ICS-23 proof in `dydx-attest.js` roots into. It can be read with an ICS-23
proof against Osmosis's own `app_hash`, verified with **veritape's existing `ics23.js`, unmodified**, and corroborated
byte-for-byte across three independently operated Osmosis providers.

That closes the circularity described in `dydx-attest.js` lines 35–40. `TRUST.CHECKPOINTED` becomes reachable.

---

## 1. Which chains hold a live IBC client of dYdX

Enumerated from **dYdX's own state** (`/ibc/core/connection/v1/connections`, 46 connections at height 99,352,219 via
`https://dydx-ops-rest.kingnodes.com`), then **verified from the counterparty side** by listing that chain's own
`client_states` and filtering `chain_id == "dydx-mainnet-1"`.

| Chain | Client ID | Status | `latest_height` | Verified from counterparty |
|---|---|---|---|---|
| `noble-1` | `07-tendermint-59` | **Active** | 99,352,324 | yes (229 clients scanned) |
| `osmosis-1` | `07-tendermint-3009` | **Active** | 99,328,639 | yes (3,740 clients scanned) |
| `injective-1` | `07-tendermint-256` | **Active** | 99,351,078 | yes (348 clients scanned) |
| `neutron-1` | `07-tendermint-72` | **Active** | 99,347,573 | yes (211 clients scanned) |
| `stride-1` | `07-tendermint-133` | **Active** | 99,344,330 | yes (177 clients scanned) |

**Cosmos Hub does NOT hold a dYdX client.** Measured: `cosmoshub-4` has 1,500 IBC clients and **zero** with
`chain_id == "dydx-mainnet-1"`, and dYdX's own connection list contains no `cosmoshub-4` counterparty. The task brief
listed Cosmos Hub as a plausible candidate; it is not one. Same result for **Celestia** (175 clients, zero dYdX).

Other chains with a dYdX client but **not usable** (stale by millions of blocks, i.e. abandoned): `kaiyo-1` (Kujira,
latest 59,024,891 — ~40M blocks behind), `phoenix-1` (Terra, 97,943,957), plus assorted dead clients on `archway-1`,
`quicksilver-2`, `kyve-1`, `coreum-mainnet-1`. One client on `vota-ash` is **frozen** (`frozen_height` non-zero) —
i.e. a real light-client misbehaviour was proven there at some point. Do not use any of these.

---

## 2. Retention — how far back the stored consensus states go

Measured from `count_total` (authoritative count) and from the **timestamps inside the oldest and newest stored
consensus states** (primary data, not inferred from block height).

| Chain | Stored states | Oldest height | Oldest timestamp | **Retention** |
|---|---|---|---|---|
| `osmosis-1` | 15,059 | 63,358,572 | 2025-11-14T17:50:08Z | **255.9 days** |
| `noble-1` | 30,913 | 82,551,938 | 2026-04-01T08:35:50Z | **118.2 days** |
| `neutron-1` | 3,135 | 93,794,986 | 2026-06-16T14:31:48Z | **42.0 days** |
| `injective-1` | 927 | 94,305,802 | 2026-06-20T01:15:04Z | **38.6 days** |
| `stride-1` | 2,173 | 96,073,497 | 2026-07-01T19:01:20Z | **26.8 days** |

**Retention is not the constraint.** The brief's worry — "pruned to the last few hundred blocks, so it only works for a
live read" — is measurably false here. Every one of the five covers a two-day window many times over. IBC's
07-tendermint prunes only *expired* states, and does so lazily, so history accumulates.

> Measurement discipline note: an earlier pass of this reported Noble's newest state as 91,981,353 and its recent
> update gaps accordingly. That was **wrong** — an ascending-pagination truncation at `limit=20000` silently cut the
> list. Re-measured with `pagination.reverse=true` and `count_total=true`. The numbers above are the corrected ones.

---

## 3. Trusting period, and how stale the newest state actually is

| Chain | `trusting_period` | `unbonding_period` | `max_clock_drift` | Newest state staleness (at check) |
|---|---|---|---|---|
| `noble-1` | 2,203,200 s = **25.5 d** | 2,592,000 s = 30 d | 600 s | **16 s** |
| `osmosis-1` | 1,612,800 s = **18.67 d** | 2,592,000 s = 30 d | 28 s | **272 s** |
| `injective-1` | 1,728,000 s = **20 d** | 2,592,000 s = 30 d | 75 s | **1,174 s** |
| `neutron-1` | 1,612,800 s = **18.67 d** | 2,592,000 s = 30 d | 13 s | **3,294 s** |
| `stride-1` | 2,203,200 s = **25.5 d** | 2,592,000 s = 30 d | 600 s | **5,253 s** |

All five report `status: Active`. Staleness is seconds-to-90-minutes against a trusting period of 18–25 days — not
remotely near the edge.

**Update cadence**, measured as the interval between the newest 401 stored consensus states (seconds):

| Chain | p50 | p90 | p99 | max | window covered |
|---|---|---|---|---|---|
| `noble-1` | 313 | 1,393 | 4,357 | **7,573** (2.1 h) | 2.80 d |
| `osmosis-1` | 255 | 9,008 | 28,224 | **66,874** (18.6 h) | 13.88 d |
| `injective-1` | 3,600 | 3,604 | 3,607 | **5,145** (1.4 h) | 16.54 d |
| `neutron-1` | 2,606 | 5,380 | 5,394 | **10,835** (3.0 h) | 12.92 d |
| `stride-1` | 20 | 2,853 | 20,986 | **21,193** (5.9 h) | 6.25 d |

Noble is the freshest and most regular; Injective is metronomic (hourly relayer); Osmosis is deepest but bursty.

An important distinction the brief's framing invites getting wrong: **the trusting period governs light-client *jumps*,
not lookups.** We are not asking a client to skip to a new height. We read a consensus state that was *already written*
and *already validated* by the host chain's validators at write time. A state older than the trusting period is expired
for the purpose of serving as a trust root for a new update, but it remains a valid historical record of what that
chain's validator set committed to. For checkpointing a past height, expiry does not disqualify it.

---

## 4. Reading one end to end — the measurement that decides this

### 4a. First result was a false alarm, and the correction matters

The initial cross-check reported `next_validators_hash` **MISMATCH** on all five chains while `app_hash` and timestamp
matched perfectly. A 48-byte value against a 32-byte one is not a chain disagreement, it is a decoding bug — and it was
mine. The Cosmos REST layer serves:

- `root.hash` as **base64** (it is a plain `[]byte`)
- `next_validators_hash` as **uppercase hex** (it is `cmtbytes.HexBytes`, which marshals to hex in JSON)

Base64-decoding a 64-char hex string yields 48 bytes, which is exactly what was printed. Once decoded correctly the
value is **identical** to the dYdX RPC's. This is the same failure mode as the "not committed under a key" refusal that
turned out to be a key-name error: an apparent loud disagreement that was self-inflicted. Reported here so it is not
rediscovered.

### 4b. Corrected cross-check: 60/60

5 chains × 3 dYdX RPCs × 4 fields (`app_hash@H`, `next_validators_hash@H`, `time@H`, `validators_hash@H+1`):
**every single check MATCH.** No disagreement anywhere.

The identities confirmed live:

```
IBC consensus_state(H).root.hash            == dydx header[H].app_hash
IBC consensus_state(H).next_validators_hash == dydx header[H].next_validators_hash
                                            == dydx header[H+1].validators_hash
IBC consensus_state(H).timestamp            == dydx header[H].time
```

The first identity is the prize. **The consensus-state root *is* the dYdX `app_hash`** — not a proxy for it, not the
validator set that signs it, the actual value every ICS-23 proof in `dydx-attest.js` roots into. Pinning it does not
require reasoning about validator sets at all.

### 4c. The rigorous version: proven, not trusted, and corroborated

Reading a checkpoint from an LCD merely swaps one trusted HTTP endpoint for another. So the consensus state was instead
read **out of Osmosis's own IAVL store** with `abci_query prove=true`:

```
store: ibc
key:   clients/07-tendermint-3009/consensusStates/1-99352531
```

Verified with **veritape's existing `verifyStoreProof` from `src/adapters/ics23.js`, called unmodified**:

| Osmosis provider | ICS-23 | appRoot == Osmosis `app_hash` | proof |
|---|---|---|---|
| `https://rpc.osmosis.zone` | verified | **MATCH** | 1,811 B, depth [27,6] |
| `https://osmosis-rpc.polkachu.com` | verified | **MATCH** | 1,811 B, depth [27,6] |
| `https://osmosis-rpc.publicnode.com` | verified | **MATCH** | 1,811 B, depth [27,6] |

Byte-identical value from all three: **true**. `Any.type_url = /ibc.lightclients.tendermint.v1.ConsensusState`.

Decoded out of the proven bytes:

```
PROVEN dydx app_hash             @99352531 = FAF51AEA39A4F54284A5DD72A5E2199DD82ED64588479E3A87586A1442030009
PROVEN dydx next_validators_hash @99352531 = 5718E9C7A9C771C59C1AA53312C641ED96884B98BECE41D47DB9CE400BA086DF
```

Cross-checked against all three dYdX RPCs at that height: `app_hash@H` MATCH, `nvh@H` MATCH, `validators_hash@H+1`
MATCH, on every one. **INDEPENDENT CHECKPOINT ESTABLISHED: true.**

### 4d. All five chains, proven — not just Osmosis

The same proven read was then run against every one of the five chains: fetch the consensus state from that chain's own
`ibc` store with `prove=true`, verify ICS-23 with veritape's `verifyStoreProof`, confirm `appRoot` equals that chain's
own `app_hash`, decode, and compare to the dYdX RPC.

| Chain | Checkpoint height | Providers proving it | `app_hash` vs dYdX RPC | `nvh` vs dYdX RPC |
|---|---|---|---|---|
| `osmosis-1` | 99,328,639 | **3** | MATCH | MATCH |
| `injective-1` | 99,345,127 | **2** | MATCH | MATCH |
| `neutron-1` | 99,353,270 | **2** | MATCH | MATCH |
| `noble-1` | 99,352,661 | 1 | MATCH | MATCH |
| `stride-1` | 99,344,329 | 1 | MATCH | MATCH |

**5 of 5 chains yield a cryptographically proven checkpoint, and all 5 agree with the dYdX RPCs.** Five disjoint
validator sets, independently maintained, all committing to the same dYdX `app_hash` history.

Provider availability differs sharply and this is what should drive the choice: Osmosis has three independent working
RPCs (`rpc.osmosis.zone`, Polkachu, PublicNode), Injective and Neutron two each, while **Noble and Stride have only
one reachable RPC each — both Polkachu**. Noble is the freshest source (§3) but reading it through a single operator
reintroduces exactly the single-provider dependency this exercise exists to remove. Prefer **Osmosis, Injective or
Neutron** for a proven, corroborated checkpoint; use Noble only as a freshness supplement, never alone.

---

## 5. What this actually buys, stated exactly

Do not let this be quoted as "trustless". The precise statement:

**Before.** To forge an attestation, an attacker needs one malicious RPC endpoint. It invents a validator set of its own
keys, signs a fabricated block, and checks 1–6 all pass because the validator set and the header come from the same
source. Cost: running a server.

**After.** The `app_hash` is additionally required to equal a value stored in Osmosis's state tree, proven by ICS-23
against an Osmosis `app_hash` that Osmosis's validators signed. To get a forged value into that slot, an attacker must
submit a dYdX header to Osmosis's 07-tendermint client that passes *its* verification — which requires signatures from
**more than 1/3 of the dYdX validator set as recorded in Osmosis's trusted consensus state**, by stake, and that
evidence is slashable and permanently on chain.

The attack moves from *"operate a web server"* to *"control >1/3 of dYdX's staked voting power and get caught doing
it"*. That is the entire point of a weak-subjectivity checkpoint, and it is now measurable rather than aspirational.

**The recursion, honestly.** We have no independent checkpoint for *Osmosis*. Reading Osmosis via three Osmosis RPCs has
the same structural shape as the original problem. What makes it not a shell game: (a) the attacker must now corrupt
**two disjoint validator sets and two disjoint RPC operator sets simultaneously**, (b) Osmosis's commit signatures are
verifiable with the same code already in the adapter, and (c) the client has been continuously updated since 2025-11-14
at the latest (measured oldest state) with real value flowing over the channel — a client fed a fabricated dYdX would
have diverged from the real chain long ago and broken live token transfers. Recursion bottoms out at "some real
validator set with real stake", which is the standard and accepted answer. It is not zero trust; it is trust priced in
slashable stake instead of in a hostname.

**Still not fixed by any of this:** freshness is not attested (providers can withhold or delay); nothing says dYdX's
oracle price is *correct*, only that the chain committed to it. Attestation is provenance, never truth. Those caveats in
the adapter header stand unchanged.

---

## 6. The binding constraint is dYdX RPC pruning, not IBC

To use a checkpoint at height H, the dYdX RPCs must still serve an ICS-23 proof at H. Measured by binary search on
`abci_query /store/prices/key prove=true`. Measured dYdX block time: **0.608 s/block** (over a 9,990-block span), so
2 days = **284,058 blocks**.

| dYdX RPC | Deepest height serving a proof | In time |
|---|---|---|
| `https://dydx-rpc.publicnode.com` | ~100 blocks | **~1 minute** |
| `https://dydx-ops-rpc.kingnodes.com` | 99,611 blocks | 16.8 h |
| `https://dydx-rpc.kingnodes.com` | 100,099 blocks | 16.9 h |
| `https://dydx-dao-rpc.polkachu.com` | **2,468,750 blocks** | **17.4 days** |

Beyond the limit the node returns code 7, `"proof is unexpectedly empty; ensure height has not been pruned"` — an
explicit prune, not a silent empty proof.

**Consequences, and they are the real finding:**

1. **Live checkpointed attestation: WORKS.** A Noble checkpoint is typically ~313 s old (≈515 blocks), worst case
   7,573 s (≈12,455 blocks). Both kingnodes and polkachu serve proofs that deep. `MIN_CORROBORATORS = 2` is met.
   `publicnode` drops out beyond ~1 minute, so it usually cannot corroborate a checkpointed anchor.

2. **`publicnode` is nearly useless for anything but the tip.** It prunes to roughly the last 100 heights. The current
   adapter anchors at `tip - 3`, which is why this has never bitten. It will bite the moment the anchor moves back.

3. **Two-day historical attestation: NOT currently possible at the adapter's own corroboration floor.** At 284,058
   blocks deep, only `polkachu` serves a proof. That is **one** provider, below `MIN_CORROBORATORS = 2`. The IBC side is
   fine (Noble covers 118 days, Osmosis 256 days) — it is the dYdX archive side that fails.

4. **Independent-operator counting.** `dydx-ops-rpc.kingnodes.com` and `dydx-rpc.kingnodes.com` are the **same
   operator**. The adapter counts endpoints, not operators. Beyond ~100 blocks deep the honest operator count is
   **two** (Kingnodes, Polkachu), not three. Worth a comment in `DYDX_RPCS` so nobody reads three-endpoint agreement at
   depth as three-party agreement.

A wide sweep for additional dYdX RPCs (13 further hostnames: lavenderfive, whispernode, autostake, nodestake, ibs.team,
quasarstaking, stakeandrelax, architectnodes, highstakes, chainroot, validatornode, ecostake) found exactly **one** new
live endpoint — `dydx-rpc.kingnodes.com`, same operator as one already in use. The public dYdX archive-RPC set is thin.
Unblocking the 2-day window needs a second archive-grade provider, or a self-run pruned-nothing node.

---

## 7. Fallbacks if IBC were unavailable

Recorded for completeness; **none is needed given §4**, and all are weaker because each rests on one party.

> **Sourcing caveat, read this before quoting §7.** Unlike every other section of this document, the items below are
> **from background knowledge and are NOT live-measured**. They are structural descriptions of what these fallbacks
> are, not verified claims about what any named provider is publishing right now. A separate measurement pass was
> commissioned to fetch actual values; if its results are not appended below, treat this section as unverified. The
> conclusion of §7 does not depend on the details — the IBC route in §4 dominates all of them regardless.

- **State-sync trust hashes.** Cosmos operators publish `trust_height` + `trust_hash` for state-sync bootstrapping;
  these are genuinely out-of-band published block hashes. **Attempted to measure and failed**: four candidate URLs
  (`polkachu.com/api/v2/chains/dydx/state_sync`, `polkachu.com/state_sync/dydx`,
  `snapshots.polkachu.com/state_sync/dydx/`, `services.kjnodes.com/mainnet/dydx/`) returned 404/400/403 respectively.
  So **no live trust_height/trust_hash value was obtained for dydx-mainnet-1 in this pass** — the URLs above are simply
  wrong, not evidence the fallback does not exist. Structural weaknesses regardless: each is one operator asserting a
  hash on a web page, values rotate away leaving no history, and the largest publishers are **the same companies
  operating the RPCs we would be checking** — Polkachu and Kingnodes are already two of our three dYdX corroborators,
  so this would add little genuine independence.
- **Explorers** (Mintscan, Ping.pub, etc.) largely proxy the same public RPC set; they are presentation over the same
  data, not an independent validator-set observation.
- **`cosmos/chain-registry`** carries the genesis URL, seeds and peers for dYdX, but is not a source of ongoing
  block-hash checkpoints; it pins chain identity at genesis, not current validator sets.
- **dYdX Foundation / `dydxprotocol/v4-chain` releases** publish upgrade heights and binaries, not weak-subjectivity
  checkpoints.

Judgement: the IBC route is strictly better than all of these — it is on chain, historical, machine-readable, covers
months, and is maintained by a validator set with stake at risk rather than by a webserver.

---

## 8. Concrete implementation recipe (not yet built — no adapter was touched)

To make `TRUST.CHECKPOINTED` returnable, in `openAnchor()`:

1. Pick the checkpoint chain. **Prefer `osmosis-1` (3 independent proving providers), `injective-1` or `neutron-1`
   (2 each)**; `noble-1` and `stride-1` are reachable through only one operator each (§4d). Requiring agreement from
   ≥2 of the five costs nothing — all five were measured to produce proven, mutually consistent checkpoints.
2. Read the newest stored consensus height `H` for the client (`.../consensus_states/{cid}?limit=1&reverse=true`).
3. **Set the anchor to `H`**, not `tip - 3`: `anchor.headerHeight = H`, `anchor.height = H - 1`.
4. Fetch `clients/{cid}/consensusStates/1-{H}` from the host chain's `ibc` store with `prove=true`, verify with the
   existing `verifyStoreProof({ops, store:'ibc', key, value})`, and check `appRoot` against the host chain's own
   `app_hash` — then verify the host chain's header hash, validator set and commit signatures with the **existing**
   `headerHash` / `validatorSetHash` / `verifyCommitSignatures`. No new cryptography is required anywhere.
5. Unwrap the protobuf `Any` (`type_url = /ibc.lightclients.tendermint.v1.ConsensusState`), then decode
   `ConsensusState{1: timestamp, 2: MerkleRoot{1: hash}, 3: next_validators_hash}`.
6. Require `dydx header[H].app_hash == root.hash` **and** `dydx header[H].validators_hash == checkpoint(H-1).nvh` or
   equivalently `header[H+1].validators_hash == checkpoint(H).nvh`. Refuse on mismatch — never downgrade silently, in
   keeping with how the module already handles corroboration failure.
7. Only then return `TRUST.CHECKPOINTED`.

Watch out for: the LCD hex-vs-base64 asymmetry (§4a); pagination truncation on ascending queries (§2); `publicnode`
dropping out as a corroborator once the anchor moves off the tip (§6).

---

## 9. Reproduction

Scripts used are in the session scratchpad under `.../scratchpad/ibc/`: `conns.mjs` (dYdX connection enumeration),
`findclients.mjs` (counterparty client discovery), `cadence2.mjs` (retention + staleness + cadence),
`e2e2.mjs` (60/60 cross-check), `depth.mjs` (RPC prune-depth binary search), `fullchain3.mjs` (the full proven
checkpoint, importing veritape's own `ics23.js`), `multichain.mjs` (proven reads across all five chains).

The §4c/§4d result was reproduced **twice, ~20 minutes apart**, the second time against a build of `ics23.js` that a
concurrently running agent had edited in between (`ics23.js` mtime 14:44:16Z, `dydx-attest.js` 14:45:56Z — neither
edit mine). It passed identically both times, on live endpoints, at different Osmosis heights.

Constraints honoured: **no file under `src/engine/` was read or modified** (published hash `q1-e1fa99d08887d6cc`
unaffected); **no adapter was modified** — `ics23.js` was imported and called read-only; nothing deployed; nothing
spent; `V2_IBC_CHECKPOINT.md` is the only file written.
