# Verifiability

*The reason the rest of this exists. Full treatment in Sections 3 and 5.19 of the
[technical documentation](https://quiver-production-c3a8.up.railway.app/paper).*

An agent buying a number cannot supervise the party that produced it. Most agent-facing services
answer that with a signature, which proves who spoke and nothing about whether they were right. This
service answers it differently, and the difference is worth being precise about — including where it
stops.

---

## Two envelopes, and they are not interchangeable

**A proof envelope** rides on every deterministic answer. It carries the echoed inputs, the engine's
`codeHash`, a `contentHash` over `{engine, codeHash, inputs, result}`, the self-check results, and —
when a signing key is configured — a secp256k1 signature over that hash.

The strong guarantee is not the signature. It is that you can **re-derive the number**: clone the
repository, confirm the `codeHash` matches what `/build` serves, re-run the open engine on
`proof.inputs`, and get a byte-identical result. Our honesty is not in the loop, because you did the
computation.

**An observation envelope** rides on every answer that reads a live venue. It carries the same
content hash and signature plus an `observedAtUtc`, and its `semantics` field states outright that
the answer is **not** re-runnable and why. Markets move; pretending otherwise by signing everything
and implying reproducibility is exactly the costume this design refuses.

What an observation buys is **accountability, not correctness** — the ability to hold a specific
answer, from a specific build, at a specific instant, against what the market later did, months
later, without our cooperation. That is the honest ceiling of any live-data guarantee from any
provider.

The distinction is enforced in code. A result carrying live provenance cannot be sealed in a proof
envelope: the constructor routes it to an observation envelope instead. That rule lives in the
envelope rather than at each call site because fixing call sites one at a time failed four separate
times — see Section 11.7.

---

## What a self-check catches, and what it cannot

Each engine tests its output against the condition it was solved from: the liquidation condition,
the Kelly first-order condition, the constant-product `k`, the martingale `E[S_T] = F`, the
arbitrage-free density.

**They bite.** A reviewer with live access copied the engines aside, corrupted one formula in each,
and every corruption was caught — six for six — at tolerances tight enough that a one-percent error
moves the residual by hundreds of units.

**And here is their limit, stated plainly because an earlier version of this document oversold it.**
These checks establish that the closed form matches the condition *as coded*. They do not validate
the inputs, and they do not validate the choice of model. If the maintenance-margin rate is wrong for
the venue, `perp-gate` computes a wrong liquidation price and the invariant still passes at a
residual near machine epsilon — because both sides of the comparison use the same wrong rate. **They
catch implementation error; they cannot catch specification error.** The phrase "ground-truth
invariant" oversold that distinction and has been withdrawn.

Two of the five reach further and are worth naming as the exceptions:

- **`options-risk`** checks all six analytic greeks against finite differences of an *independently
  repriced* book. This caught a real defect and forced a machine-precision normal CDF.
- **The recovered density's martingale residual** tests a numerical integration against a quantity
  derived by a completely different route.

The only verifier in this system that is **not ours at all** is the venue's own published liquidation
price, which `portfolio-gate` compares against our computed one and fails beyond 2.5 points. It is
correctly not enforced for cross-margined legs, because there the venue's number and ours model
different things — which means the external check is off exactly where our model is furthest from the
truth. That is a limitation, and it is [labelled as one](limitations.md).

`allSelfChecksPass` is deliberately tri-state: `false` if any check failed, `true` only if every
check explicitly passed, and `null` when nothing conclusive ran. It used to read a skipped check as
passing, so a response where nothing was checked published `true`.

---

## Three tiers of trust on the live-data path

The largest limitation in this system is that the envelope is signed by **our own server**, so for
live data a signature establishes that we spoke, not that we were honest about what we fetched. It
does not touch the deterministic path at all, where you re-derive the number yourself.

It also is not uniform, and pretending it were would understate the good cases and hide the real one.
Measured across 1,785 responses an independent buyer desk actually received:

| Tier | What it is | What you must trust |
|---|---|---|
| **Pinned on-chain state** | `calldata-x` publishes the block number and block hash its simulation ran against | **Nothing.** Re-query any node at that block; you get the same state or you catch us |
| **Immutable public history** | A settled candle series, a past trade tape, a replayed swap sequence | Nothing, *after the fact* — it is re-fetchable and comparable, just not in the moment |
| **Ephemeral live state** | An order book, a mid, a volatility surface at an instant that will never recur | Our fetch. This is the irreducible core, and it is much smaller than "all live data" |

The remedies for the third tier are real and named rather than gestured at: a **zkTLS** proof attests
that a particular TLS session with a particular host returned particular bytes — exactly the missing
link, since the computation on those bytes is already re-derivable — and a **hardware enclave**
attests the execution instead. Neither is trustless in the way the word is usually sold: zkTLS moves
the trust to a notary that can still collude with a prover, and an enclave moves it to a hardware
vendor's root of trust. Both move it to a *named party with published assumptions*, which is strictly
better than moving it nowhere. Neither is shipped, and on the day we went to check the best-known
public notary it was down at the origin — confirmed from a second, unrelated network.

Two limits on that tier map itself: it was measured over the fourteen services the buyer desk
exercised, and the remaining eight were classified from their source, which is weaker. An absent
marker in that sweep means the desk never called the service, not that the service lacks the field.

---

## Verify one yourself

```bash
# 1. the build identity. The response carries its own hashing rule and the exact file list, so a
#    verifier can never hold a stale recipe and accuse a correct build (REPRODUCIBLE.md once did).
curl -s https://quiver-production-c3a8.up.railway.app/build

# 2. a real deterministic answer, free
curl -s -X POST https://quiver-production-c3a8.up.railway.app/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"perp_gate",
       "arguments":{"side":"long","entryPrice":64000,"size":1,"leverage":10,"maintMarginRate":0.0125}}}'
```

Then recompute `sha256(canonical({engine, codeHash, inputs, result}))` — the response carries the
recipe in `proof.verifyContentHash` — and recover the signer with
`ethers.verifyMessage(contentHash, signature)`. A fully worked example, with the settlement that paid
for it, is in [checkable artifacts](checkable-artifacts.md).
