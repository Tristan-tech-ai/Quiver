# `eth_getProof` anchoring: the mechanism works, and it does not reach `lp-desk`'s data

**28 July 2026. Research and working code, repo-only. Nothing is served, deployed, or on chain.
Nothing under `src/engine/` was touched, and `q1-e1fa99d08887d6cc` was verified unchanged before and
after.**

PHASE_D_RESEARCH §7 puts this in the shippable-in-weeks bucket:

> **`eth_getProof` anchoring for `lp-desk` and `calldata-x`.** About 6 KB per pool, works on the free
> RPCs already in use, and `calldata-x` already records the block anchor.

Every one of those clauses is true. The conclusion built on them is half right, and the half that is
wrong is the half about `lp-desk`.

---

## 1. What was wrong

§4.3 opens with "`lp-desk` and `calldata-x` read chain state." `calldata-x` does. **`lp-desk` does
not read chain state at all.**

Read `univ3.js`. Every number `lp-desk` replays arrives through `fetchSwaps` -> `decodeSwap`, which
slices `log.data` from an `eth_getLogs` result:

```js
const amount0 = toSigned(w(0), 256), amount1 = toSigned(w(1), 256);
const sqrtPriceX96 = BigInt('0x' + w(2)), liquidity = BigInt('0x' + w(3));
const tick = Number(toSigned(w(4), 256));
```

Event logs are committed to the **`receiptsRoot`**. `eth_getProof` proves the **`stateRoot`**. Those
are different tries in the same header, and no `eth_getProof` of any size or depth will ever contain
a Swap event. The remaining metadata does not help either: `token0`, `token1`, `fee` and
`tickSpacing` are Solidity `immutable`, which means they live in the deployed **bytecode** and
occupy no storage slot. Measured, slots 0 through 9 of the ETH/USDC 0.05% pool:

```
slot 0  0x00014402d302d301b20310ac00000000000059d94cf49d21c747e0590512c4dc   slot0 (packed)
slot 1  0x000000000000000000000000000000000000ece7484cbe76a637fc32f0be9d22   feeGrowthGlobal0X128
slot 2  0x000000000000000000000000000017804c62b8a1cc7f5c8d0bfdd09f657a2fca   feeGrowthGlobal1X128
slot 3  0x000000000000000008d97d8df573d8fd0000000000000000000000004ebd89a1   protocolFees
slot 4  0x0000000000000000000000000000000000000000000000005230233c6a8dec84   liquidity
slot 5  0x0000000000000000000000000000000000000000000000000000000000000000   ticks (mapping base)
slot 6  0x0000...0000   tickBitmap      slot 7  0x0000...0000   positions
slot 8  0x0100000000000000020...   observations[0]
```

No token addresses anywhere. `token0()` returns USDC and `token1()` returns WETH from code, not from
state.

So the honest version of §4.3's claim is: **`eth_getProof` anchors `calldata-x` cleanly and reaches
`lp-desk` only through one narrow bridge**, described next.

---

## 2. The bridge, and what it costs

`slot0.sqrtPriceX96` and `slot0.tick` are written **only** by `swap()`. `Mint`, `Burn`, `Collect` and
`Flash` never touch them. Therefore at the end of a block, storage slot 0 must equal the post-state
that the **last** Swap event in that block emitted. Proving slot 0 at block B proves the terminal
Swap row of block B, and no other row in it.

That invariant is asserted by the code and measured by the gate, never assumed. Live, 23 terminal
rows on ETH/USDC 0.05%:

| field | proven slot vs the log lp-desk used |
|---|---|
| `sqrtPriceX96` | 23 / 23 |
| `tick` | 23 / 23 |
| `liquidity` | 23 / 23 |

`liquidity` is deliberately reported as a separate, weaker claim even though it matched every time
here: slot 4 **is** written by `Mint` and `Burn`, so a mint or burn landing after the last swap in
the same block moves storage without moving the log. That divergence was not observed in 23 blocks,
which is not the same as it being impossible, and the adapter reports the field separately rather
than folding a lucky sample into a guarantee.

**The cost is the coverage ceiling**, and it is worse exactly where it matters most. Coverage is
`distinct blocks / swaps`, so a busy pool is a badly covered pool. Measured over ~1,200 blocks
(~4 hours), mainnet:

| pool | swaps | blocks | anchorable rows | swaps/block |
|---|---|---|---|---|
| **ETH/USDC 0.05%** | 1,059 | 586 | **55.3%** | 1.81 |
| ETH/USDC 0.30% | 118 | 102 | 86.4% | 1.16 |
| WBTC/ETH 0.30% | 25 | 25 | 100.0% | 1.00 |
| USDC/USDT 0.01% | 276 | 228 | 82.6% | 1.21 |
| WETH/USDT 0.30% | 230 | 197 | 85.7% | 1.17 |
| LINK/ETH 0.30% | 38 | 37 | 97.4% | 1.03 |

ETH/USDC 0.05% is the pool `lp-desk` names in its own error message and the pool the whole
LP-vs-HODL finding was measured on. It is the worst covered of the six. Base WETH/USDC measured
62.1% and Arbitrum WETH/USDC 36.8% on the same method.

---

## 3. Which quantities are now anchored

Stated as a table because partial coverage stated honestly beats full coverage implied. This is
`LP_DESK_COVERAGE` in `src/adapters/univ3anchor.js`, and gate E asserts on it so it cannot drift away
from the code.

### `lp-desk`

| quantity | used for | anchored? |
|---|---|---|
| `sqrtPriceX96` per swap | price path, realised vol | **PARTIAL**: terminal rows only, 55.3%-100% by pool |
| `tick` per swap | the in-range test driving every rebalance | **PARTIAL**: same bridge |
| `liquidity` per swap | fee share `L/(activeL+L)` | **PARTIAL, WEAKER**: terminal rows, and only when no Mint/Burn follows |
| `amount0` / `amount1` | `feeAmt`, the entire fee accrual | **NO**: a trade size is never written to state |
| `feeAmt` | the headline LP-vs-HODL number | **NO**: inherits amount0/1 |
| block number, timestamp | window span, vol scaling | **YES, BY A DIFFERENT MECHANISM**: header fields, keccak-verified against `blockHash`; no state trie involved |
| `token0` / `token1` / `fee` / `tickSpacing` | decimals alignment, fee tier | **NO (INDIRECT ONLY)**: `immutable`, so bytecode; reachable via account `codeHash` plus a bytecode extraction that is not built here |
| token `decimals` (d0, d1) | every price and every amount | **NO**: slot differs per token, often a constant; not generically locatable, so the adapter refuses rather than guessing a slot number |

**Not one `lp-desk` quantity is anchored outright by a storage proof.** The single "YES" is the block
header, and it is a different mechanism. `feeAmt`, the number the service exists to produce, is
structurally unreachable, because trade sizes live in receipts.

### `calldata-x`

This is where it works, and it works well.

| quantity | anchored? | how |
|---|---|---|
| spender tier (contract vs EOA) | **YES** | account leaf `codeHash`; EOA iff `keccak256('')` |
| `activity.outboundTxCount` | **YES** | account leaf `nonce`, verbatim |
| `activity.codeSizeBytes` | **YES** | `keccak256(eth_getCode)` checked against the proven `codeHash` |
| proxy implementation / beacon | **YES** | direct storage proofs on the three EIP-1967 / zeppelinos slots |
| `isProxy: false` | **YES, VIA EXCLUSION PROOFS** | the empty case needs a *verified* exclusion proof |
| simulation asset/approval changes | **NO** | a counterfactual execution is not committed state; §4.3 says so already and is right |
| `gas.gasPriceGwei` | **NO** | a node-local estimate |
| ERC-20 symbol / decimals | **NO** | same per-token slot problem |

`calldata-x`'s loudest output is its DANGER verdict for an unlimited approval granted to an
address that is a wallet (EOA) rather than a protocol contract. Every input to that verdict is now
Merkle-anchored. So is
`UPGRADEABLE_PROXY_TARGET`, including the negative case, which is the one that needed exclusion
proofs: three slots reading zero is only a sound "not a proxy" if their emptiness is *proven*. An
absent proof is not an exclusion proof, and the adapter refuses to conflate them. Otherwise a
hostile node could hide an upgradeable implementation by simply omitting a field.

And §4.3's last clause pays off exactly as advertised: `calldataX.js`'s evidence bundle already
carries `pinnedState: { baseBlockNumber, baseBlockHash }`, and that base block is precisely the block
whose state an anchor proves. The anchor slots into a field that already exists.

---

## 4. The trust chain, stated exactly

A verified proof says only: *a state trie whose root is R contains value V at key K*. Three separate
links have to hold, and they are three different kinds of claim.

**Link 1, the trie.** Keccak-chained nodes from R to the leaf, with hex-prefix path decoding and
inline-node handling. Pure cryptography, no trust. Both outcomes are proofs: an inclusion proof for a
value, an exclusion proof for an absent key.

**Link 2, the header.** R must be the `stateRoot` inside a header whose
`keccak256(rlp(header)) == blockHash`. Also pure cryptography, and it is what stops an RPC handing
back a `stateRoot` belonging to no block at all. Measured: this reconstructs with **21 fields** on
ethereum and base (through `requestsHash`) and **16** on arbitrum (through `baseFeePerGas`). The tail
is fork-dependent, so the encoder stops at the first absent field and **refuses** if the hash does
not come out, rather than guessing which fork it is talking to.

**Link 3, canonicity. NOT CLOSED, and this is the honest ceiling.** Nothing here proves the block is
canonical or has the network's weight behind it. A malicious RPC answering everything from a
fabricated chain passes links 1 and 2 *perfectly*, because it supplies the header it is checked
against and can mint a matching root and a matching proof.

The only available mitigation is measured, not assumed: ask several independent operators for the
header and report whether they agree. Three mainnet operators are wired. MEV Blocker
(CoW/Beaverbuild), OnFinality, publicnode (Allnodes), and all six pools anchored at **3/3
agreement**. That raises the cost of forgery from one compromised endpoint to all three. It is not a
proof of anything, and the envelope text says so in those words.

**The asymmetry that makes this usable at depth**, which was the surprise of the day: proofs and
headers have different availability. Walking each endpoint back until it refused:

| endpoint | serves `eth_getProof` at | serves `eth_getBlockByNumber` at |
|---|---|---|
| `rpc.mevblocker.io` | head-1,000,000 (full archive) | head-100,000 + |
| `eth.api.onfinality.io/public` | head-256, refuses head-1,024 | head-100,000 + |
| `ethereum-rpc.publicnode.com` | head-64, refuses head-128 | head-100,000 + |
| `arb1.arbitrum.io/rpc` | ~200-256, and the boundary moves between runs | (not tested) |
| `mainnet.base.org` | head-8 only, rate-limits within a few calls | (not tested) |
| `base-rpc.publicnode.com` | refuses at every depth ("maximum proof window") | (not tested) |

So at `lp-desk`'s real 2-day window (head-14,400 on mainnet) the **proof** is servable by exactly
**1 of 3** operators, while the **root** is still corroborated by **3 of 3**. The single archive node
supplies the bytes; three independent operators still agree on what those bytes must chain to. Gate E
measures both numbers at that depth rather than quoting them.

**What would actually close link 3**: a consensus-layer light client, or an on-chain verifier reading
`BLOCKHASH` / the EIP-2935 history contract, where the block hash comes from consensus rather than
from an HTTPS response. That is the same argument §4.4 makes for the Hyperliquid precompile: the
off-chain version is the honest first half of an on-chain check, not a substitute for it.

---

## 5. Measured cost

Every number below was produced by running the code, on the block named. None is quoted from §4.3.

**§4.3's 6 KB figure reproduces exactly, and it is the single-slot figure.** One slot on ETH/USDC
0.05%: account proof 8 nodes / **3,764 B**, storage proof **2,309 B**, total **6,073 B**. §4.3 said
3,764 B and 2,309 B. Byte-identical, months apart, which is a real corroboration of that measurement.

But one slot is not what an anchor needs. `slot0` alone does not carry `liquidity`:

| slots proven | account | storage | total decoded | wire (JSON hex) |
|---|---|---|---|---|
| 1 (`slot0`) | 3,764 B | 2,309 B | **6,073 B** | 12,631 B |
| 2 (`slot0` + `liquidity`) | 3,764 B | 4,626 B | **8,390 B** | 17,349 B |
| 5 (slots 0-4) | 3,764 B | 11,354 B | **15,118 B** | 31,117 B |

Two things §4.3 does not mention. First, **the wire form is 2.07x the decoded size**. Proofs arrive
as JSON hex strings, so "6 KB" costs 12.6 KB of bandwidth and 8.4 KB costs 17.3 KB. Second, the
account proof is paid once but **each additional storage slot costs a full ~2.3 KB path**, with
shared prefix nodes re-sent: 11.5% of the storage bytes are duplicates at 2 slots, 18.7% at 5. A
deduplicating encoder would recover that; `eth_getProof` as specified does not.

Across six real pools at block 25,631,638, two slots each:

| pool | account B | storage B | total B | wire B | ms | agreement |
|---|---|---|---|---|---|---|
| ETH/USDC 0.05% | 3,764 | 4,626 | 8,390 | 17,348 | 311 | 3/3 |
| ETH/USDC 0.30% | 3,751 | 4,306 | 8,057 | 16,688 | 128 | 3/3 |
| WBTC/ETH 0.30% | 3,815 | 3,984 | 7,799 | 16,170 | 249 | 3/3 |
| USDC/USDT 0.01% | 3,847 | 3,192 | 7,039 | 14,634 | 286 | 3/3 |
| WETH/USDT 0.30% | 3,911 | 3,982 | 7,893 | 16,350 | 111 | 3/3 |
| LINK/ETH 0.30% | 3,847 | 3,598 | 7,445 | 15,458 | 200 | 3/3 |

**Median 7,893 B decoded, 16,350 B on the wire, 249 ms.** Latency over 12 fetches: min 152, p50 262,
p90 313, max 434 ms. Depth is free: head-16 and head-14,400 measured 364 ms and 315 ms median on the
archive node, so proving a two-day-old block costs no more than proving a recent one.

**L2s are near-head only, and "near" is worse than the block counts suggest.** Arbitrum anchors at
head-200 (8,459 B, 342 ms) and refuses at head-256 with `missing trie node`. That boundary is not
stable: an earlier sweep the same day had 256 succeeding and 1,024 failing, because the node prunes
as it advances. At ~0.25s blocks, 200 blocks is **under a minute of history**. Base anchors at head-8
(8,858 B, 324 ms), roughly **16 seconds**, and then rate-limits. So
`lp-desk`'s 2-day window **cannot be anchored on Base or Arbitrum at all** on the free RPCs, and
mainnet works only because MEV Blocker happens to serve archive proofs.

---

## 6. Gate E, and the proof that it can fail

`gates/gateE-ethproof-anchor.mjs`, 15 tests, **passes**. Most of it is the red half, because a gate
that only ran the honest half would pass identically if `verifyMpt` were `return { ok: true }`.

The red half runs against a **local tamper proxy** on 127.0.0.1 that sits in front of a real RPC and
rewrites its answers, then feeds them through the same `anchorState()` the green half uses. Testing
the verifier with hand-built bytes would prove it works on hand-built bytes; this proves the adapter
refuses a hostile server.

```
E1  GREEN  6/6 pools anchored, layout confirmed against each pool's own getters, 3/3 agreement
E2  GREEN  6/6 terminal swap rows agree with proven slot0 on sqrtPriceX96 + tick (and liquidity)
E3  RED    fabricated storage VALUE (honest proof, lying echo)          -> refused
E4  RED    trie leaf rewritten to encode a different number             -> refused
E5  RED    proof lifted from a different block, header honest           -> refused
E5  RED    doctored stateRoot                                           -> refused at the HEADER link
E6  RED    truncated proof / empty proof read as "value is zero"        -> refused
E7  RED    lying account echo (nonce)                                   -> refused
E8  RED    bytecode not hashing to the proven codeHash                  -> refused
E9  RED    6 verifyMpt corruptions + an honest positive control         -> all refused
E10 RED    USDC decoded as a V3 pool; an EOA decoded as a pool          -> refused
E11 RED    an intra-block swap row                                      -> refused as unanchorable
E12 GREEN  calldata-x: proxy, non-proxy via exclusion proofs, EIP-7702
E13 CTRL   5 honest runs, 0 false refusals
E15        at head-14,400: proof servable by 1/3 operators, root agreed by 3/3
E14        the coverage table cannot claim more than the code delivers
```

Two of those deserve a note. **E5's crude variant is caught by link 2, not link 1**: a doctored
`stateRoot` fails the header reconstruction before the trie is ever walked, and the refusal says so
rather than reporting a proof mismatch. **E11 is the coverage boundary as a test**: a non-terminal
row is refused with its reason, not compared against a value it has no reason to equal.

### The revert

`gates/gateE-revert.mjs` deletes the one line the whole construction rests on, the check that each
proof node keccak-hashes to what its parent commits to, and requires the gate to go red:

```
GATE E REVERT, proving the eth_getProof anchor gate can fail

1/3  baseline: the gate as shipped must be GREEN
     pass=15 fail=0

2/3  reverted: node-hash check removed, the gate must go RED
     pass=11 fail=4
     red tests: E4 RED, E5 RED, E9 RED, E14
     as required: 4 test(s) went red once proofs stopped being checked against their root.

3/3  restored: the gate must go GREEN again
     pass=15 fail=0

=== GATE E REVERT: PASS, the gate goes red when the verification is removed and green when it is restored ===
```

Deleting that line does not break the program. It leaves something that still walks a trie, still
decodes leaves, still returns plausible values. It just no longer checks that the nodes belong to
the root, which is the entirety of what a Merkle proof is. Four tests notice. Eleven do not, which is
the useful part: **most of a green gate would survive the removal of the thing it is testing.**

---

## 7. Refusals built in, and one defect ground truth caught

The adapter refuses rather than guessing when: a header will not reconstruct; a node chain breaks; a
proof is truncated or absent; the RPC's unproven echo contradicts the proven leaf (both `nonce`/
`codeHash` on the account and `value` on a slot); a storage layout cannot be confirmed; slot 0 fails
the sqrtPrice-implies-tick arithmetic; served bytecode does not hash to the proven `codeHash`; a
requested slot has no proof; or the caller asks for `latest` instead of a fixed height.

The storage **layout** is an assumption about a contract, and an assumption is not evidence, so it
gets two independent defences: the sqrtPrice/tick relation (adversary-independent arithmetic on the
proven bytes) and equality with the pool's own `slot0()` / `liquidity()` getters at the same block.
The second confirms the *slot map* only: `eth_call` is unproven, so it rules out misdecoding a V3
fork such as Algebra, never a lying node. Both are stated that way in the code.

**The defect.** A first run reported `vitalik.eth` as `tier: contract` with 23 bytes of code. It is
an EIP-7702 delegated wallet, and `calldataX.js` draws exactly that distinction on purpose: its
`🚨 DANGER` verdict for "unlimited approval to a wallet, not a protocol contract" keys on it. An
anchor that collapsed 7702 into "contract" would have quietly downgraded the one alert it exists to
support. Now `eoa7702` with the delegation target extracted, bound to the proven `codeHash`, and E12
asserts it. It was found by running the thing against a real address, not by reading the code.

**A second, smaller one worth recording**: a free node under load stops answering JSON and starts
serving an HTML rate-limit page. The first gate run read those as verification failures. Transport
failures and verification failures are different events, and a gate that conflates them reports
cryptographic failures that never happened. Both adapters now mark transport errors explicitly,
retry only those, and never retry a verification result.

---

## 8. What this contradicts in §4.3, and what it confirms

**Confirmed.** The 6 KB single-slot figure, byte-for-byte (3,764 B account + 2,309 B storage).
Latency in the 250-350 ms band. Free keyless RPCs. Verifiable against the header `stateRoot`.
Byte-identical results from independent operators. `calldata-x` already recording a block anchor,
and it is the right block. `eth_simulateV1` output being unprovable this way.

**Contradicted or materially incomplete.**

1. **"`lp-desk` … read[s] chain state."** It does not. It reads event logs, committed to the
   `receiptsRoot`. The entire fee accrual (`amount0`/`amount1` -> `feeAmt`) is structurally
   unreachable by any state proof.
2. **"About 6 KB per pool."** 6 KB is one slot. A useful pool anchor is two slots and measures
   **8,390 B decoded / 17,349 B on the wire**. The wire figure is the one that gets paid for.
3. **"works on the free RPCs already in use."** The RPCs already in use largely do *not* serve
   proofs at useful depth. `ethereum-rpc.publicnode.com`, the endpoint §4.3 timed at 251 ms, refuses
   `eth_getProof` past head-128. `base-rpc.publicnode.com` refuses it entirely. Mainnet archive
   anchoring rests on `rpc.mevblocker.io` being unusually generous, and Base and Arbitrum are
   near-head only.
4. **Coverage is unstated and it is the binding constraint.** Even where everything works, only the
   terminal swap of each block is anchorable: **55.3%** of rows on the pool `lp-desk` actually uses.
5. **"shippable in weeks" is right for the wrong service.** For `calldata-x` it is close to done:
   the code in this document anchors every account-level quantity its danger verdicts rest on. For
   `lp-desk` the work is not weeks of engineering, it is a change of mechanism: anchoring its data
   means proving *receipts*, which is a different trie, a different proof, and not what §4.3
   described.

---

## What none of this would ever prove

A verified `eth_getProof` proves a value was in a trie. It does not prove the trie is the canonical
chain's, and this document does not close that gap. Three operators agreeing on a block hash is a
cost increase for an attacker, not a proof, and it is labelled that way in every envelope the adapter
returns. Only a consensus-layer light client, or a verifier running where `BLOCKHASH` comes from
consensus instead of from an HTTPS response, closes it.

And even fully closed, it would prove that Uniswap's pool held that `sqrtPriceX96`, never that the
price was right, that the pool was not manipulated in that block, or that a backtest built on it
means anything. §7(d) of the research is unaffected by anything here: provenance is not truth, and
the strongest possible version of this work only makes `lp-desk`'s *inputs* checkable, on the roughly
half of them that a state proof can reach.

## Files

| | |
|---|---|
| `veritape/src/adapters/ethproof.js` | MPT inclusion + exclusion verification, header RLP -> blockHash, multi-operator corroboration, `anchorState`, `anchorAddress` |
| `veritape/src/adapters/univ3anchor.js` | V3 slot map with two layout defences, `anchorPoolState`, `anchorSwapRow`, the coverage tables |
| `veritape/gates/gateE-ethproof-anchor.mjs` | 15 tests, green + red halves, local tamper proxy; **passes** |
| `veritape/gates/gateE-revert.mjs` | deletes the node-hash check, requires red, restores, requires green; **passes** |

Mirrored byte-identically into `Quiver/` at the same relative paths. `npm run gate:e`,
`npm run gate:e-revert`. Nothing is served, no service emits any of this, and no verifier for it
exists on chain.
