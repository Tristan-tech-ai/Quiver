# A contract checks the arithmetic, without trusting the seller

An agent buys a liquidation price from Quiver. A contract on X Layer decides whether that number is
right. Nothing about Quiver's identity, uptime, signature or reputation is load-bearing in that
sentence — which is the whole point of it.

## Live on X Layer, 28 July 2026

| | |
|---|---|
| `QuiverProofRegistry` | [`0xd50A91E36673443749Ee22031cb2Ff09d4Bb8D60`](https://www.okx.com/web3/explorer/xlayer/address/0xd50A91E36673443749Ee22031cb2Ff09d4Bb8D60) |
| `PlonkVerifier` | [`0x59F6Aa860eE0d26Db873f7c7015CE869170b3b25`](https://www.okx.com/web3/explorer/xlayer/address/0x59F6Aa860eE0d26Db873f7c7015CE869170b3b25) |
| Attestor | `0x946324E0E5d7D77206731E35Ef4044a383e2a8C2` |
| **Accepted** | [`0x50397d71…f368a`](https://www.okx.com/web3/explorer/xlayer/tx/0x50397d713b96414800fef2dc6c2b4b8a48bd89d7f793683df9deddfbe73f368a) — block 66412787, 468,459 gas, `ProofAccepted` |
| **Rejected** | [`0x97502c78…4aac`](https://www.okx.com/web3/explorer/xlayer/tx/0x97502c78e61958a9a1013a257bf281c665684e214d6474c41444eb0294cb4aac) — block 66412794, 333,155 gas, `ProofRejected` |

The accepted proof was **bought from the live endpoint**, not generated locally. The rejected one is
the same proof with the certified liquidation price moved by a single grid step — one part in 1e9.

## Check it yourself, without our cooperation

Ask the live service for an answer and a proof of it:

```bash
curl -s -X POST https://quiver-production-c3a8.up.railway.app/mcp \
  -H 'content-type: application/json' -H 'accept: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"perp_gate","arguments":{"side":"long","entryPrice":64000,"size":1,"leverage":10,"maintMarginRate":0.0125,"snark":true}}}'
```

Then fetch the proof by content hash — it is free, and a third party can pull the proof for someone
else's answer:

```bash
curl -s https://quiver-production-c3a8.up.railway.app/proof/8575ce5ae5bfae9cdfdfc604250f8032e4ba85fb33560386586b7538d0ab0960
```

Read back what the chain decided, from a public RPC that is not ours and not OKX's:

```bash
cast call 0xd50A91E36673443749Ee22031cb2Ff09d4Bb8D60 "liquidationPrice(bytes32)(uint256,uint256)" 0x25669da50feb5d2dc6f6daaade452e7d22324183706330174218c8196c036206 --rpc-url https://xlayer.drpc.org
```

That returns `58329` and `113924051` — 58329.113924051, against the 58329.11 the service sold. The
served price is rounded to two decimals for display; the proof certifies the full-precision value.

The verification key is published at
[`/proof/vk`](https://quiver-production-c3a8.up.railway.app/proof/vk), so the proof can also be
checked off-chain with `snarkjs plonk verify`.

## What the contract does and does not check

The circuit already pins everything the arithmetic needs: every input is range-bounded, `side` is
forced to exactly ±1, the maintenance rate is forced below 1, size is forced non-zero, and the
residual is bounded by `|2R| ≤ q(SCALE + mmr)` inside the constraint system. The contract therefore
re-checks **none** of it. Redundant `require` statements over facts a SNARK already enforces cost gas
and buy the appearance of rigour.

**Two claims, kept apart.** A proof says the arithmetic is correct. It does not say Quiver sold it.
Pairing the envelope signature with a proof would leave a gap you could drive a position through — a
valid proof of one position beside a valid signature over another, each fine alone. So the service
signs `keccak256(abi.encodePacked(uint256[8] publicSignals))`, the same eight words the contract
hashes from calldata, and the contract recovers the signer itself.

**An unattested proof is still accepted**, and recorded as unattested. The arithmetic stands on its
own or the exercise is pointless. An impostor signature over the right digest does not set the flag.

**Rejections are events, not reverts.** A revert leaves a failed transaction and nothing else; a bad
proof offered to a public registry should leave a permanent, indexable record that it was refused.

## Why PLONK, at 13% more gas and 22× the proving time

The Groth16 circuit is complete and faster in every dimension — 32 ms to prove against 703 ms, a
256-byte proof, 13% less gas. It is not used, because its circuit-specific ceremony had a single
participant and that participant was our machine. Anyone holding that toxic waste can forge proofs.
Deploying that verifier and inviting reliance on it would be exactly the failure this project
criticises in others. PLONK uses the public Hermez reference string, which we did not run.

## Latency

Proving is 703 ms and never touches the request path. It runs in a **separate process**, so the paid
answer is unaffected and the event loop stays free for everyone else. Measured against production:

| | p50 | p95 |
|---|---|---|
| `perp_gate`, no proof | 310 ms | 343 ms |
| `perp_gate`, `snark: true` | 341 ms | 403 ms |
| `perp_gate`, no proof, five proofs building | 336 ms | 384 ms |

Those are end-to-end from a residential connection; the network floor to the host was 273 ms of it.
Server-side compute is 37 ms plain and 68 ms with a proof requested.

The first version ran the prover on the main thread. Node has one, and ~700 ms of unbroken WASM
arithmetic froze the event loop for 506 ms — so callers who had asked for no proof at all were paying
for someone else's, and production p95 was one full second. That was found by measuring production,
not by reading the code. A regression test now asserts event-loop lag rather than wall-clock latency,
because a latency assertion against a remote host is a flake generator.

Worker threads do not work here: snarkjs builds its curve through ffjavascript, which assumes any
non-main thread is one of its own workers and reads a `workerData` field that does not exist.

## Reproduce the whole thing

```bash
node zk/scripts/gate3-registry.mjs     # deploys both contracts into a local EVM and runs 15 checks
```

It buys from the engine, waits for the proof the service builds, and puts **that** on chain — not a
fixture. The only interesting failure is a break between circuit and service, and a fixture sails
past it.
