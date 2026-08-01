# Full paid sweep of all 22 services, on the official OKX Payment SDK

**1 August 2026.** Every service bought with real money on X Layer (`eip155:196`, USD₮0), from
`0x1b010a9cf4c6302a0ffcfec08e2fbf23e3e1f0d4` (Account 2, agent #6166) to the listing owner
`0x65bb932d9987f1d1a98b8942a3fa98cb28ec073b`. Harness: `sweep22-sdk.mjs`.

This was run because the paid rail had been dead for seventeen hours on 31 July and 1 August while every
check this repository owns stayed green. A 402 that looks correct says nothing about whether settlement
lands, so the only instrument that answers the question is a buyer, paying, and then the chain.

## Result

**22 of 22 services delivered an answer and settled on chain**, across two passes on the same build.

| | pass 1 (22 fixtures) | pass 2 (3 real inputs) | total |
|---|---|---|---|
| delivered (HTTP 200) | 19 | 3 | **22 / 22** |
| settled with a transaction hash | 19 | 3 | **22 / 22** |
| claimed by receipts | 0.330000 | 0.030000 | 0.360000 USD₮0 |
| buyer balance fell by | 0.330000 | 0.030000 | 0.360000 |
| owner balance rose by | 0.330000 | 0.030000 | 0.360000 |
| receipt hashes absent from chain | 0 | 0 | **0** |

Pass 1's reconciliation was additionally checked against an independent scan of the token's transfer
log over the sweep's own block range (66,813,521 to 66,813,609): nineteen transfers totalling exactly
0.330000, every receipt hash present. The balance figures and the census agree to the last decimal, and
neither depends on the wallet's balance API, which has served stale mid-settlement values before.

**Seven of the delivered answers carried a zk proof** — `perp-gate`, `size-gate`, `exec-verify`,
`options-risk`, `lp-risk`, `treasury-risk`, `event-vol` — which matches the count the paper publishes.

## Why pass 2 exists, and why the three refusals were correct

Pass 1's request bodies come from `gates/routing-fixtures.mjs`, which exists to prove the routing
signpost stays quiet on a correct call. Its inputs are deliberately synthetic, so three services that
reach a live venue refused them, correctly and with a 400:

| service | fixture | what the service said |
|---|---|---|
| `poly-fill` | market `will-btc-hit-100k` | no active market matched it |
| `lp-desk` | pool `0x1111…1111` | pool metadata read failed |
| `risk-attest` | items `["a1b2c3","d4e5f6"]` | not 32-byte hex content hashes |

**None of the three was charged.** 0.360000 was the full catalogue price and 0.330000 was claimed, the
difference being exactly those three. That is the billing contract holding: an answer the engine refused
is not a delivery.

Pass 2 re-ran them with inputs obtained rather than recalled. The Uniswap pool
`0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640` was verified on chain before use (token0 USDC, token1 WETH,
fee 500); the two content hashes came from free MCP proofs taken minutes earlier; the Polymarket market
was read from the venue's own open-markets list. All three then delivered and settled.

## The defect this sweep found

The first attempt at this sweep, on the build shipped an hour earlier, delivered only **15 of 22** and
the other seven returned HTTP 502. The container logs named it: the non-chargeable path set an
informational header whose value contained an em dash, Node rejects a non-Latin-1 byte in a header value
with `ERR_INVALID_CHAR`, and the throw landed in an async Express handler with nothing to catch it. It
killed the process. Every service whose engine refused its own answer took the container down, and the
two requests behind it met the platform edge mid-restart, which is why the failures came in clusters of
three.

The header value is now plain ASCII and the write sits inside a guard, because an informational header
must never be able to fail a paid call whatever a later edit puts in it. `gates/gateSDK-x402.mjs` now
drives a real refusal through the HTTP layer and requires the server to still answer afterwards. That
check was the one missing: the status codes were unit-tested and correct the whole time, and no test
ever sent a refusal through Express.

Billing survived the crash intact. Fifteen calls claimed 0.295000, the balances moved by 0.295000 in
each direction, and nothing was charged for any of the seven that failed.

## Standing caveat

This is our own money moving to our own operator wallet. It is quality assurance, not revenue, and it is
counted as neither a sale nor traction, consistent with every other figure the paper publishes about the
buyer desk.

Machine-readable per-service rows: `sweep22-sdk-result.json`.
