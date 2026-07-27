# Checkable artifacts

*Appendix C of the [technical documentation](https://quiver-production-c3a8.up.railway.app/paper).*

Everything else in this repository is an assertion by us. Every row below lives outside it — on a
public chain or a public endpoint — together with the command that checks it. **None requires our
cooperation, and none can be edited by us after the fact.** If any fails to resolve as stated, treat
the corresponding claim as unproven.

Block heights are given in decimal and hex as returned by `eth_getTransactionReceipt`, because an
earlier draft converted them by hand and got all four wrong — an error found by a reviewer running
the checks this page invites, which is the page working as intended and the authors not.

---

## On chain

| What | Artifact | Where |
|---|---|---|
| ERC-8004 agent listing<br><sub>registered as *Veritape*, renamed to Quiver on 19 July, so the on-chain name differs from the current one</sub> | `0x25326e5504e5213b1a8f9dce81818157a3995ea49b17e8f1d0987fa0f1b78e7d` | X Layer (`eip155:196`), block 65,692,173 (`0x3ea620d`) |
| x402 settlement, X Layer rail (USD₮0) | `0x68444c5462bddecd1a587b762d3f7b8f2f4bce2724fa3bc04dcacdadd7cba1af` | X Layer, block 65,848,752 (`0x3ecc5b0`) |
| x402 settlement, Base rail (USDC) | `0x429a1efe31a82078bb61bc781435c09038adb3dd07d0d7641a2496a5fbb42483` | Base (`eip155:8453`), block 48,956,716 (`0x2eb052c`) |
| Second Base settlement, different service | `0x88a85f49b4d51e28eab713a436fd6112252ee0ee465e73bb01e23791d8c6a3a6` | Base, block 48,993,708 (`0x2eb95ac`) |
| **A real paid settlement for this exact service and these inputs**<br><sub>the exhibit below was regenerated later on a newer build, so this evidences the payment rail rather than that envelope</sub> | `0xa07957667cf53eb52814c4c4488027da2596f109c90f8d68f323eb60eec7e4b6` | X Layer, block 66,383,878 (`0x3f4f006`), 27 July 2026 |
| EAS attestation schema for `risk-attest` | `0x59a8587b287d3f13776dccbe49e19d2e887f90b5e16650464b07e613d89287e0`<br><sub>schema string: `bytes32 merkleRoot, uint256 itemCount, string engineVersion`</sub> | Base, EAS SchemaRegistry `0x4200…0020` |
| A Merkle root anchored under that schema | `0x01ffd2f9934a2c7f7df119e1e2043231fefe59be21011cb3184c956ea479a1b1`<br><sub>attestation `0x69d42632…`, 20 July 2026, `itemCount 2`</sub> | Base. It batches **two** computations, not a day's worth, and was produced by the pre-fix tree — so it records what was anchored on that date and is not a root the current engine reproduces |
| **A contract that verifies our arithmetic**<br><sub>PLONK verifier at `0x59F6Aa860eE0d26Db873f7c7015CE869170b3b25`; both addresses are immutables you can read back</sub> | `0xd50A91E36673443749Ee22031cb2Ff09d4Bb8D60` | X Layer, deployed 28 July 2026 |
| **A proof bought from the live endpoint, accepted on chain** | `0x50397d713b96414800fef2dc6c2b4b8a48bd89d7f793683df9deddfbe73f368a` | X Layer, block 66,412,787, 468,459 gas, event `ProofAccepted`. The registry stores `58329.113924051` against the `58329.11` the service sold |
| **The same proof with the certified price moved one grid step, rejected** | `0x97502c78e61958a9a1013a257bf281c665684e214d6474c41444eb0294cb4aac` | X Layer, block 66,412,794, 333,155 gas, event `ProofRejected`. One part in 10⁹ invalidates it — a verifier that cannot refuse is not a verifier |

```bash
# any of the above, on the matching chain
curl -s -X POST https://rpc.xlayer.tech -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionReceipt","params":["0xa07957667cf53eb52814c4c4488027da2596f109c90f8d68f323eb60eec7e4b6"]}'
# expect status 0x1, and a USD₮0 Transfer log to the advertised payTo

# what the registry decided about that position, read straight from the chain.
# returns 58329 and 113924051 — the full-precision price the proof certified,
# against the 58329.11 the service served (rounded to two decimals for display)
cast call 0xd50A91E36673443749Ee22031cb2Ff09d4Bb8D60 "liquidationPrice(bytes32)(uint256,uint256)" \
  0x25669da50feb5d2dc6f6daaade452e7d22324183706330174218c8196c036206 --rpc-url https://xlayer.drpc.org
```

## Off chain

| What | Artifact | Where |
|---|---|---|
| Build identity of the engine behind every proof here | `q1-e1fa99d08887d6cc` | served at [`/build`](https://quiver-production-c3a8.up.railway.app/build); rebuildable from this repository — the exact rule is in [REPRODUCIBLE.md](../REPRODUCIBLE.md) |
| Research artifacts behind the crash study, hashed file by file | `merkleRoot 0xd376b71f94d54967325fbddc60b5d35d478884f1a70e63e0844532c24642c784` over 14 files | [`research/RESEARCH_ANCHOR.md`](../research/RESEARCH_ANCHOR.md) — recompute each sha256 from a clone and re-derive the root through `risk-attest`. This root supersedes two earlier ones, and that history is recorded rather than tidied away |
| The buyer desk's raw settlement ledger | 1,785 rows | [`research/BUYER_LEDGER.csv`](../research/BUYER_LEDGER.csv) — `node research/buyer-ledger-recount.mjs` reproduces every figure in Section 6.4 offline, and **exits with an error** rather than printing anything if it cannot first re-derive the three figures the buyer itself published |
| Independent availability record | status page + JSON | [`cgn9npwmm0.execute-api.us-east-1.amazonaws.com`](https://cgn9npwmm0.execute-api.us-east-1.amazonaws.com/) — hosted off this service, so it stays reachable when the service is not |

---

## A worked proof, end to end

Deterministic, with explicit inputs rather than a live market read, so it is re-runnable indefinitely
rather than only at the moment of capture. Captured 27 July 2026 from the live service on the published
build and, separately, regenerated offline from this repository alone — the two agree byte for byte,
content hash included, across a Linux container and a Windows laptop.

**Request** — `POST /api/perp-gate`

```json
{ "side": "long", "entryPrice": 64000, "size": 1, "leverage": 10, "maintMarginRate": 0.0125 }
```

**Answer, and the proof it carries**

```
liquidationPrice        58329.11
moveToLiquidationPct    8.861
positionStatus          ABOVE_MAINTENANCE

proof.engine            perp-gate
proof.codeHash          q1-e1fa99d08887d6cc
proof.deterministic     true
proof.selfChecks[0]     liquidation-invariant: account_value(P_liq) == maintenance_margin(P_liq)
                        residual 2.05e-12 against tolerance 0.064 — pass
proof.contentHash       8575ce5ae5bfae9cdfdfc604250f8032e4ba85fb33560386586b7538d0ab0960
proof.signature.signer  0x946324E0E5d7D77206731E35Ef4044a383e2a8C2
proof.signature         0xcabfb1954b39b306c041d546fb151582cc7d31dce403fbdaa056d7be824188fb
                        274d2f9af2a1aa01469c2d96998c871f3a36b4ac8a6762c36f0b9d2e45c824111b
```

**Four checks, none of which needs us:**

1. **Does the arithmetic hold?** With `M = 6400`, `q = 1`, `P₀ = 64000`, `mmr = 0.0125`:
   `P_liq = (P₀ − M/q)/(1 − mmr) = 57600/0.9875 = 58329.113924…`
2. **Does the self-check hold at that price?** Account value `M + q(P_liq − P₀)` must equal the
   maintenance requirement `q·P_liq·mmr`. Residual 2.05×10⁻¹², against a tolerance scaled to notional.
3. **Does the content hash reproduce?** `sha256` over the key-sorted canonical JSON of
   `{engine, codeHash, inputs, result}`, where `result` is the response with its `proof` key removed,
   must equal the hash above. The response carries the recipe in `proof.verifyContentHash`.
4. **Does the signature recover to the published signer?**
   `ethers.verifyMessage(contentHash, signature)` must return `0x946324E0…a8C2`.

A reviewer with no stake in the answer recovered that signature offline and called it the one
artifact that cannot be bluffed.

**All four checks run offline, from this repository alone — no live call and no payment.** An earlier
draft said check 3 needed a paid call, because it needed "the full result object". It does not:
`proof.inputs` is printed above in full and the engine is open source, so the result is not merely
*received*, it can be *regenerated*. Re-running the published `perp-gate` engine on those five inputs
and sealing it exactly as the service does reproduces the exhibit in every digit — liquidation price
58329.11, self-check residual 2.05e-12, and the content hash byte-for-byte. That reproduction is
locked by a test, so an engine change that stales this page fails the build rather than quietly
misleading a reader. A paid call proves the service *served* it; the repository proves it is *right*.
Neither requires the other.
