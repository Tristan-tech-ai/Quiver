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
