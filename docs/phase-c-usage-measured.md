# Burst or trickle: the measurement both Phase C research passes said was decisive

**28 July 2026. Measured from X Layer, not from anything Quiver recorded about itself.**

Both Phase C research passes, run independently on different models, arrived at the same boundary from
different directions:

> Recursion aggregates **proofs**. Widening a circuit aggregates **statements**. Quiver holds every
> witness it sells, so widening suffices for its own batches and is useless for folding incrementally
> as an agent polls. Whether real usage is a burst or a trickle decides which tool is right, and it has
> not been measured.

This measures it.

## Method, and why it is not from our own logs

`/diag/recurrence` exists and would have been easier. It is not used here for two reasons: it is an
in-memory map that resets on every redeploy, and it is our own record of our own traffic. Payments
settle on chain, so the chain is the harder and better source.

Inbound `Transfer` logs to the payTo address `0x65bb…073b` for USD₮0 (`0x779D…3736`) on X Layer, read
through `eth_getLogs`. **X Layer's `eth_getLogs` caps a query at 100 blocks**, so this is a windowed
scan, and the measured block time is **1.00 s**, which makes 100 blocks 1.7 minutes.

## What was measured

| window, back from head | blocks | hours | inbound transfers |
|---|---|---|---|
| first scan | 12,500 | 3.5 | **1** |
| second scan | 140,000 | 38.9 | **315** |
| third scan, rate-limited | 30,000 covered of 120,000 attempted | 8.3 | **0** |

The third scan is the honest one to read carefully: 900 of its 1,200 windows failed to rate limiting,
so it covered only the most recent 30,000 blocks, and found nothing in them.

## The answer

**Trickle. Decisively, and by a wide margin.**

Take the most generous reading available, the 315 figure over 38.9 hours, and note that it counts
**every** inbound transfer to that wallet rather than only paid service calls. That is **8 per hour**,
one every 7.4 minutes. The two scans that covered the most recent hours found **one** and **zero**.

## What that settles for Phase C

Widening a circuit to state 100 answers at once requires 100 answers **to exist at once**.

At one call every 7.4 minutes, accumulating 100 answers takes **over twelve hours**. Nobody waits
twelve hours to submit a proof, and a risk answer twelve hours old is not a risk answer. Even 20, the
number the roadmap's own abandon condition names, takes two and a half hours.

So the honest reading of the abandon condition:

> "aggregation costs more than it saves below 20 answers **and** real usage never batches that many"

The second clause is now measured and it is **true**. Real usage does not batch twenty answers, and
nothing in the observed traffic comes close. The first clause was already found false by the Opus
pass, which measured widening beating separate proofs from n=2. So the condition as written cannot
fire: one half true, one half false, joined by AND.

**That is a defect in the condition, not a verdict on the work.** A rule that cannot fire is a rule
that decides nothing, and this one was written before either number existed.

## What this does NOT settle

- **It measures today, not the product.** Quiver has been live for weeks with a small number of
  external callers. A trickle now is a fact about adoption, not a law about what agents do. If one
  buyer ever polls in a loop, the shape changes overnight.
- **The 315 are not all Quiver calls.** The payTo is the owner wallet and receives other things. A
  filter by the four service prices was attempted and the RPC rate-limited before it completed. So 315
  is an upper bound on paid calls, and the true figure is lower, which makes the trickle finding
  stronger rather than weaker.
- **Per-payer inter-arrival was not obtained.** The scan that would have shown whether any single
  caller ever bursts died to rate limiting. What is measured is the aggregate arrival rate across all
  payers, which is the number Phase C needs, but a per-payer burst inside a quiet aggregate would not
  have been visible.

## What follows

**Widening is the right tool for the batches Quiver can actually assemble, and those batches are
small.** At n=2 it already beats separate proofs, measured at 268,233 gas against 543,509. The
hundred-answer figure both research passes computed is real arithmetic about a batch that does not
occur.

Folding, which is the tool for a trickle, remains out of reach: sonobe is alpha, its circom frontend
is experimental, and its decider wants tens of gigabytes. That is unchanged by this measurement.

The useful conclusion is smaller and firmer than either research pass expected: **build the widening
for n in the low single digits, where it demonstrably wins, and stop describing a hundred-answer
aggregate as the target.** The target was chosen before anybody counted the calls.
