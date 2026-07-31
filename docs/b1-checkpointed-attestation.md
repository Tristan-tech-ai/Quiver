# B1–B3 — The checkpointed dYdX attestation: BUILT, GATED, AND THE GATE CAN FAIL

**`TRUST.CHECKPOINTED` is now returned.** It had been a deliberately unreachable label since the module
was written. `openAnchor({ checkpoint: true })` returns it, and returns it only when the `app_hash`
every ICS-23 proof roots into is byte-identical to a value another chain's validators independently
committed to.

All numbers below were **measured live on 2026-07-28, 14:5x–15:3x UTC**, dYdX mainnet at height
~99,354,900. Nothing is recalled or inherited. Where this contradicts `V2_IBC_CHECKPOINT.md`, §7 says so
explicitly and gives the measurement.

---

## 1. What was built

| File | Status | What it is |
|---|---|---|
| `veritape/src/adapters/ibc-checkpoint.js` | **new**, 42 KB | the checkpoint reader: proven IAVL reads from a counterparty chain, protobuf decoders, corroboration by operator, expiry, depth regimes, and the clause list that gates the label |
| `veritape/src/adapters/dydx-attest.js` | **+5 edits, ~45 lines** | `openAnchor({checkpoint})`, the `TRUST.CHECKPOINTED` doc block, and the provider reordering the checkpointed path needs |
| `veritape/gates/gateD3c-dydx-checkpoint.mjs` | **new** | 14 tests, 8 of them negatives built from real on-chain data |
| `veritape/gates/gateD3c-revert.mjs` | **new** | 7 scripted defects across 2 files |
| `veritape/gates/gateD3-dydx-input-attestation.mjs` | **1 edit** | the stale "CHECKPOINTED must never be returned" assertion, replaced |
| `veritape/package.json` | **+2 scripts** | `gate:d3c`, `gate:d3c-revert` |

`src/engine/` was not read or modified. Engine hash **`ee6a7028…0aff4599`** over 37 files, measured
before and after: **identical**. Nothing deployed, nothing spent.

### The trust chain the checkpoint adds

```
clients/07-tendermint-3009/clientState        --ICS-23--> osmosis app_hash  (gives H, trusting period, frozen flag)
clients/07-tendermint-3009/consensusStates/1-H --ICS-23--> osmosis app_hash
  osmosis app_hash --headerHash--> commit.block_id.hash --ed25519--> >2/3 of OSMOSIS voting power
  consensus_state(H).root.hash  ==  dydx header[H].app_hash   <-- the pin
```

Then dYdX's own chain: `header[H].app_hash` --headerHash--> block id --ed25519--> >2/3 of **dYdX**
voting power, corroborated across independent dYdX providers. Both halves use the **existing**
`ics23.js` `verifyStoreProof` and the **existing** `headerHash` / `validatorSetHash` /
`verifyCommitSignatures` from `dydx-attest.js`, called unmodified. **No new cryptography was written.**

---

## 2. `TRUST.CHECKPOINTED` — returned under exactly these conditions

Set in **one place only** (`openAnchor`, guarded by `verifyAnchorCheckpoint`). All eight clauses must
hold; any failure **throws**, and there is no path that returns a weaker label instead.

1. the counterparty client tracks `dydx-mainnet-1` and is **not frozen** (`frozen_height == 0`)
2. `checkpoint.dydxHeight === anchor.headerHeight` — exactly one height, never "close enough"
3. `checkpoint.appHash === anchor.appHash` — byte-identical, 32 bytes
4. `checkpoint.nextValidatorsHash === header.next_validators_hash` — the free second binding
5. **≥ 2 independently operated** counterparty providers proved it (`MIN_CHECKPOINT_OPERATORS`)
6. all of them returned **byte-identical** consensus-state bytes (re-asserted at the bind step)
7. the checkpoint is **inside its client's trusting period**
8. each counterparty proof roots into an app_hash in a header that hashes to its commit's block id,
   with **>2/3 of the counterparty's voting power** ed25519-verified

Everything the plain path already required (dYdX header hash, validator-set hash, >2/3 dYdX signatures,
`MIN_CORROBORATORS`) still runs unchanged. A checkpoint **adds** a guarantee; it never licenses dropping one.

**Live example (gate output):**
```
checkpoint: osmosis (osmosis-1) client 07-tendermint-3009 @ dYdX height 99352531
app_hash  : FAF51AEA39A4F54284A5DD72A5E2199DD82ED64588479E3A87586A1442030009
operators : 3 [osmosis-foundation, polkachu, publicnode] — disjoint from the dYdX RPC set: [osmosis-foundation]
host sigs : osmosis-foundation 100.0%, polkachu 100.0%, publicnode 100.0%
anchor lag: 2684s (44.7 min) vs a 18.7-day trusting period
also seen : neutron@99353354, injective@99351078
```

---

## 3. Gate counts, and what the revert proves

| Gate | Result |
|---|---|
| `npm run gate:d3c` | **14 tests, 14 pass, 0 fail** (33 s) |
| `npm run gate:d3c-revert` | **7 mutations, 7 RED, restored GREEN** (14 pass / 0 fail) |
| `npm run gate:d3` (with edit, alongside another agent's funding work) | **16 tests, 16 pass, 0 fail** |

**8 of the 14 D3c tests are negatives, and 6 of those are built from real on-chain data, not mocks:**

| Negative | Built from | Result |
|---|---|---|
| wrong-height consensus state | a **real** proven consensus state from another chain/height | REFUSED |
| fabricated app_hash | one bit flipped in a real checkpoint (×3 variants) | REFUSED |
| fabricated next_validators_hash | real checkpoint, nvh replaced | REFUSED |
| **expired** checkpoint | osmosis's **oldest stored state**, dYdX height 63,358,572, **255.9 days old** vs an 18.67-day trusting period | REFUSED at **both** the read step and the bind step |
| one counterparty provider | real read restricted to `rpc.osmosis.zone` alone | REFUSED, and `openAnchor` **throws** |
| single-operator chain | `noble`, `stride` (Polkachu only) | REFUSED by default |
| unstored height | `anchor.headerHeight - 1` | REFUSED, naming its own cause |
| disputed bytes | `byteIdentical: false` | REFUSED |
| frozen client | hand-built protobuf, `frozen_height = 1-98765432` | detected |

### The revert (`gate:d3c-revert`)

Seven load-bearing clauses removed one at a time, across **two** files:

| Removed | Gate result |
|---|---|
| the app_hash equality check | 13 pass, **1 fail** |
| the checkpoint height equality check | 12 pass, **2 fail** |
| the counterparty operator floor | 12 pass, **2 fail** |
| the expiry refusal at the **bind** step | 11 pass, **3 fail** |
| the expiry refusal at the **read** step | 13 pass, **1 fail** |
| the byte-identity re-assertion | 13 pass, **1 fail** |
| the `verifyAnchorCheckpoint` call in `openAnchor` (label with no evidence) | 6 pass, **8 fail** |
| — restored — | **14 pass, 0 fail** |

**What that proves:** the gate is red in seven distinct ways and green only when every clause is
present. It is not sensitive to one thing and blind to the rest, and it is not red in both states
(which would satisfy a one-sided check while meaning nothing). The last row is the important one: with
the verification call removed the label is still *issued*, and **8 tests catch it** — a
`TRUST.CHECKPOINTED` that is asserted rather than earned cannot survive this gate.

**One clause is NOT covered by a negative, stated rather than hidden:** the byte-identity check inside
`readCheckpoint` (as opposed to the re-assertion at the bind step) can only fail if a real provider
lies, which cannot be produced without mocking. It is why the re-assertion exists at the bind step,
where it *is* reachable and *is* reverted above.

---

## 4. Depth regimes — reported, never silently degraded

**The constraint is dYdX RPC pruning, and the trap is that BLOCK retention and STATE retention are
different windows on the same node.** Measured, `commit` at H+1 versus `abci_query prove=true` at H:

| depth | publicnode | kingnodes (×2 endpoints, 1 operator) | polkachu |
|---|---|---|---|
| tip−3 | commit + proof | commit + proof | commit + proof |
| ~15 min (1,480 blk) | commit **only** | commit + proof | commit + proof |
| ~5 h (29,600 blk) | commit **only** | commit + proof | commit + proof |
| ~17 h (100,000 blk) | commit **only** | commit + proof | commit + proof |
| **2 days (284,058 blk)** | commit **only** | commit **only** | commit + proof |
| 30 days | commit only | commit only | **none** |

`probeProofDepth()` measures this at the anchored height at runtime (the table above is documentation;
the function is the ground truth for a given run) and classifies:

- **`live`** — ≥3 operators can prove state (within ~100 blocks of the tip)
- **`recent`** — 2 operators (kingnodes, polkachu), out to ~100k blocks / ~17 h
- **`archive-only`** — 1 operator (polkachu). Corroboration by *provers* is gone.
- **`unserved`** — 0 operators, beyond ~2.47 M blocks / ~17.4 days

Every checkpointed anchor carries `anchor.proofDepth` with the regime, the proving operators, and the
per-endpoint reason for each refusal. Gate output from a live run:

```
anchor  @99352530 -> recent       [kingnodes, polkachu]   (openAnchor counted 3 header-serving providers)
2 days  @99068321 -> archive-only [polkachu]
30 days @95089374 -> unserved     [none]
```

**The gap that number closes:** `openAnchor.corroborators` counts providers that served a **header**.
At 2-day depth that is **3**, while exactly **one operator on earth** can serve the state proof there.
Reading the former as the latter is how "three independent providers" quietly becomes one. `proofDepth`
is the honest number and the gate asserts the two diverge at depth.

---

## 5. The freshness cost, measured — and it is not small

A checkpoint is by construction a **past** height: the anchor moves from `tip−3` to whatever the
counterparty relayer last submitted. Measured anchor lag across runs: **11–52 minutes**.

That has a direct, measured price:

| quantity | at the tip (gateD3, ~5 s gap) | at a checkpointed anchor (44.7 min gap) |
|---|---|---|
| maintenance / initial margin | 0 divergence, 2,958/2,958 | **0 divergence**, 80/80 and 24/24 observations |
| oraclePrice vs a **live** indexer read | worst 3.121e-3 (31% of the 1e-2 bound) | worst **1.833e-2 = 183% of that bound** (40 markets); repeat runs 8.623e-3 and 1.514e-2 |

**gateD3's oracle bound does not apply at a checkpointed anchor and this gate does not pretend it
does.** The static parameters — exact on both sides, derived from the same integer ppm fields — are what
gateD3c asserts, because they are the check that actually confirms the checkpointed anchor is proving
real dYdX state at the right height. Comparing a live indexer price against a checkpointed anchor is
comparing across the anchor lag, not measuring divergence.

**Stated plainly: checkpointing buys provenance and costs freshness.** Both anchors should stay
available; neither dominates. Nothing here attests freshness, and nothing says the oracle price is
*correct* — only that the chain committed to it.

---

## 6. What this actually buys

**Before.** Forging an attestation needs **one malicious web server**: invent a validator set of your own
keys, sign a fabricated block, and checks 1–6 all pass because the validator set and the header come
from the same source.

**After.** The app_hash must *also* equal a value inside Osmosis's state tree, proven by ICS-23 against an
Osmosis app_hash that **70 Osmosis validators signed** (measured: 100.0% of voting power, all three
providers). Getting a forged value into that slot means submitting a dYdX header that passes Osmosis's
own 07-tendermint client — requiring signatures from **>1/3 of dYdX's validator set by stake**,
slashably and permanently on chain.

The attack moves from *"operate a web server"* to *"control >1/3 of dYdX staked power and get caught
doing it"*. **That is trust priced in slashable stake, not zero trust.**

The recursion is real and does not vanish: there is no independent checkpoint for *Osmosis*. What makes
it not a shell game is that an attacker must corrupt **two disjoint validator sets** simultaneously, and
that the client has been continuously updated with real value flowing over the channel since 2025-11-14
(measured oldest stored state) — a client fed a fabricated dYdX would have diverged long ago and broken
live transfers. Recursion bottoms out at "some real validator set with real stake".

---

## 7. Where this CONTRADICTS or corrects `V2_IBC_CHECKPOINT.md`

### 7.1 — A 2-day historical checkpointed attestation **WORKS**. The brief says it cannot.

V2 §6.3 and the task brief both state: *"a two-day historical checkpointed attestation fails the
module's own `MIN_CORROBORATORS = 2` floor, because only Polkachu serves proofs that deep."*

**Measured: it does not fail, and the stated mechanism is wrong.**

```
2-day historical checkpoint: stored H=99065304, age 53.5 h, 3 osmosis operators, expired=false
  trust                = CHECKPOINTED
  dydx corroborators   = 3 (header)      proofDepth.regime = archive-only [polkachu]
  primary reordered to = dydx-dao-rpc.polkachu.com
  PROVEN @2d: oraclePrice=64472.54696  maintMargin=0.012  maxLev=50  (2,437 proof bytes)
```

`MIN_CORROBORATORS` gates `openAnchor`, which counts providers that answered `status` and `commit`. **All
four dYdX endpoints serve `commit` two days deep** (§4), so the floor is met — and always was. It was
never a check on state-proof availability. Verified directly on the *non*-checkpointed path too:

```
NO-CHECKPOINT 2-day path, anchor height 99072532
  openAnchor SUCCEEDED: corroborators=3   sigs 24/30, 85.4% power
  proveMarket (bare proveKey via primary): FAILS -> code 7 proof is unexpectedly empty
  proveKeyAny: OK via https://dydx-dao-rpc.polkachu.com
```

**The real blocker was a provider-selection bug, not the corroboration floor.** `proveMarket` uses bare
`proveKey`, which pins `anchor.primary` — whichever provider answered `status` first, in practice
publicnode, which prunes state at ~100 blocks. The funding path already uses `proveKeyAny` and was
unaffected. On the checkpointed path this is now fixed by reordering `anchor.providers`/`primary` to the
providers **measured** to serve state at that exact height. **`proveMarket` on a plain pinned anchor
still has this bug** — out of scope here, but it is a one-line `proveKey` → `proveKeyAny` change and
someone should make it.

And the security reading inverts: **at archive depth a single byte-carrier is safe precisely *because*
the app_hash is externally pinned.** `proveKey` re-roots every proof into the checkpointed app_hash, so a
lying carrier is caught by the same check that catches an honest one serving the wrong height.
Checkpointing is *most* valuable exactly where corroboration by provers is unavailable.

### 7.2 — The checkpoint height needs **no** trusted discovery. V2's recipe uses an LCD.

V2 §8.2 says to read the newest stored consensus height from
`.../consensus_states/{cid}?limit=1&reverse=true` — an ordinary trusted web server, in the middle of a
design whose entire purpose is removing one.

**Measured: `clients/<id>/clientState` is itself a proven IAVL read** carrying `latest_height`,
`trusting_period`, `unbonding_period`, `max_clock_drift` and `frozen_height`. All five chains' decoded
values cross-check **MATCH 5/5** against their LCDs. The module takes the height from the proof. The LCD
appears only in `discoverStoredHeights()`, which is labelled discovery-only, is used for *historical*
heights nobody can enumerate over ABCI, and whose every output is subsequently **proven**.

### 7.3 — Counterparty RPC operators **overlap** the dYdX RPC operators. V2 does not mention this.

V2 §4d ranks the chains by provider count. It does not ask *whose* providers. Measured:

| chain | operators | **disjoint** from the dYdX set (publicnode / kingnodes / polkachu) |
|---|---|---|
| **osmosis** | osmosis-foundation, polkachu, publicnode | **1 — `osmosis-foundation`** |
| neutron | polkachu, publicnode | **0 — a strict subset** |
| injective | polkachu, publicnode | **0 — a strict subset** |
| noble | polkachu | 0, and only one operator at all |
| stride | polkachu | 0 |

A checkpoint read through the same three companies still adds a **validator set** (which is the security
gain, and an RPC operator cannot mint one), but adds **no new observer** (the liveness/censorship gain).
Only `osmosis` currently supplies both. `readBestCheckpoint` therefore ranks disjoint-operator chains
first and freshness second, and reports `disjointOperators` / `sharedOperators` either way. Without
this, a freshness-first ranking silently picks Neutron — measurably the weaker choice.

### 7.4 — Historical checkpointing is **coarse**, and V2 does not state the granularity.

A counterparty stores only the heights its relayer submitted. Osmosis holds **15,059 states over 255.9
days** — roughly one per 1,470 s against a **0.608 s** block time, so **~99.96% of dYdX heights have no
checkpoint and never will**. Measured: a 2-day target of 99,068,321 resolved to stored height
99,065,304 — **3,017 blocks / 31 minutes coarser**. `readCheckpoint({dydxHeight})` at an unstored height
refuses and names the cause. **You cannot checkpoint a height you chose; you choose from the heights
that were checkpointed.**

### 7.5 — Deliberate divergence on expiry.

V2 §3 argues that for checkpointing a past height, expiry *does not disqualify* a stored state, since
the trusting period governs light-client jumps rather than lookups. **That reasoning is correct**, and
this module still **refuses expired checkpoints by default** — per the task's explicit requirement, and
because an expired client is often an *abandoned* one whose last write may predate a halt or an
unrelayed upgrade. `allowExpired: true` is available as a conscious opt-in, and even then
`verifyAnchorCheckpoint` refuses to attach the **label**. Both refusals are reverted in the gate.

### 7.6 — Confirmed unchanged.

Five chains carry live dYdX clients with the client IDs V2 lists; Osmosis has 3 proving providers,
Injective and Neutron 2, Noble and Stride 1; retention is not the constraint;
`consensus_state(H).root.hash == dydx header[H].app_hash` holds on all five; `ics23.js` verifies the
counterparty proof **unmodified**; and the hex-vs-base64 LCD asymmetry V2 §4a caught is real (this
module never parses REST for a load-bearing value, so it cannot be bitten by it).

---

## 8. One unexplained transient, reported rather than buried

Once, at ~15:00 UTC, **all three** Osmosis providers returned **70/70 INVALID precommits** within the
same second, at heights that verified perfectly minutes later and in **8/8** subsequent runs:

```
ibc-checkpoint: no osmosis provider served a proven client state:
  rpc.osmosis.zone: 70 osmosis-1 precommit(s) present but INVALID at 67324546 — refusing
  osmosis-rpc.polkachu.com: 70 ... at 67324545 — refusing
  osmosis-rpc.publicnode.com: 70 ... at 67324545 — refusing
```

**The cause was not established.** Ruled out by direct measurement: it is *not* `canonical:false` (which
yields *fewer* signatures, not invalid ones — measured 43/70 present at tip-0 on polkachu, 0 failed);
*not* a non-zero round (height 67324544 has `round=1` and verifies 70/70); and not a validator-set
mismatch (the set hash matched, or a different error would have fired). Heights 67324543–67324548 all
verify 70/70 on re-test.

**What the module did is the part that matters: it REFUSED.** It did not downgrade, and it did not
attach a label. A transient that fails closed is the correct failure. The error message now carries the
round, the `canonical` flag, the validator count and a sample vote timestamp so the next occurrence is
diagnosable instead of re-investigated from zero.

---

## 9. Honest limits that survive a fully green run

- **Freshness is not attested.** The anchor is 11–52 minutes behind the tip, and providers can still
  withhold or delay. §5 quantifies the cost.
- **Nothing says the oracle price is correct**, only that the chain committed to it. A manipulated
  oracle is attested with full force. Attestation is provenance, never truth.
- **Operator identity is inferred from hostname and ownership, not proven.** Two hostnames could share
  infrastructure without saying so, and this module would not know.
- **The recursion does not bottom out at zero trust**, it bottoms out at slashable stake (§6).
- **`proveMarket` on a plain pinned anchor still uses bare `proveKey`** and will false-refuse off the tip
  (§7.1). Fixed only on the checkpointed path.
- **The read-step byte-identity check has no negative test** (§3).
- **The `Quiver/` mirror is a full day stale for all of Phase D** — see §10.

---

## 10. Mirror status — needs a coordinated sync, and cannot run as mirrored

Copied to `judging/Quiver/` at the same relative paths:
`src/adapters/ibc-checkpoint.js`, `gates/gateD3c-dydx-checkpoint.mjs`, `gates/gateD3c-revert.mjs`.

**They cannot run there yet, and this is not something this work should have fixed unilaterally.** The mirror
was last synced **2026-07-27 17:08** — a full day before *any* of the Phase-D attestation work. It
contains **no** `dydx-attest.js`, **no** `ics23.js`, **no** `ethproof.js`, **no** `hyperliquid-attest.js`,
**no** `univ3anchor.js`, and had **no `gates/` directory at all** (this work created it). `ibc-checkpoint.js`
imports `./ics23.js` and `./dydx-attest.js`, both absent.

this work did **not** copy those files across, because `dydx-attest.js` and `ics23.js` are being actively edited
by another agent right now and mirroring a mid-edit file is worse than not mirroring. this work also did **not**
add `gate:d3c` scripts to the mirror's `package.json` — a script that cannot run is a false claim in a
public repo.

**Phase D needs one coordinated mirror sync once the concurrent funding work lands.** The mirror repo is
otherwise clean (`git status` empty, HEAD `f28234d`); nothing was committed.

---

## 11. Reproduction

```bash
cd veritape
npm run gate:d3c            # 14 tests, ~33 s, live against dYdX + Osmosis mainnet
npm run gate:d3c-revert     # 7 mutations across 2 files, each must go RED, then GREEN
npm run gate:d3             # 16 tests, unchanged behaviour on the un-checkpointed path
```

```js
import { openAnchor, TRUST } from './src/adapters/dydx-attest.js';
const a = await openAnchor({ checkpoint: true });
a.trust === TRUST.CHECKPOINTED;   // true
a.checkpoint.appHash === a.appHash.toUpperCase();  // true — the pin
a.proofDepth.regime;              // 'live' | 'recent' | 'archive-only' | 'unserved'

// pick the chain explicitly, or take a historical checkpoint:
await openAnchor({ checkpoint: { chain: 'osmosis' } });
await openAnchor({ checkpoint: { chain: 'osmosis', dydxHeight: 99065304 } });
```

Constraints honoured: `src/engine/` untouched (hash `ee6a7028…0aff4599`, 37 files, verified before and
after); nothing deployed; nothing spent; `dydx-attest.js` and `ics23.js` re-read immediately before and
after every write, and the concurrent agent's edits are intact (`gate:d3` green at 16/16 including its
funding tests).
