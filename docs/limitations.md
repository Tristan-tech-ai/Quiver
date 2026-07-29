# Limitations

*Section 8 of the [technical documentation](https://quiver-production-c3a8.up.railway.app/paper),
condensed. Nothing is omitted here for being unflattering; where this file is shorter than the paper
it is shorter in words, not in items.*

A service is only as trustworthy as its account of what it cannot do. Each item below is labelled,
because conflating two kinds of limitation would be its own small dishonesty:

- **[structural]** — imposed by available data, market microstructure, or statistics. No amount of
  engineering on our side removes it.
- **[scheduled]** — an approximation shipping today because the better treatment is not built yet.
  Each carries a definition of done in the [roadmap](roadmap.md).

Nothing is moved out of this list for being merely unbuilt. Neither is unfinished work allowed to
pose as a law of nature.

---

### 1. [structural] The envelope is signed by our own server

For live data a signature establishes that we spoke, not that we were honest about what we fetched.
It does not touch the deterministic services, where you re-derive the number yourself and our honesty
is not in the loop. The gap is not uniform across the catalogue — it separates into three tiers, only
the third of which is irreducible, and the remedies for that third are named. **Full treatment:
[verifiability](verifiability.md).**

### 2. [scheduled] The per-leg liquidation model is isolated margin

On a cross-margined account that is the wrong model by orders of magnitude: on a real five-leg book
the isolated view read *3% away* while the venue's own cross-margin prices sat between 240% and
62,000% away. Two consequences were understated for a while. The venue cross-check — the only
verifier here we do not control — is enforced for isolated legs and correctly cannot be enforced for
cross ones, so it is off exactly where the model is furthest from the truth. And an autonomous caller
polling an endpoint takes the default, which is what an agent does.

What changed is the disclosure, not the model: the nearest-liquidation headline now names the margin
model it solved under, says outright that its number is *not* the book's distance when any leg is
declared cross, points at the account-level figure that is comparable, and treats silence about
margin mode as an assumption rather than as isolated.

### 3. [structural] Dealer positioning in GEX is an assumption

The sign convention assumes dealers are long call gamma and short put gamma. An earlier version of
this page, and of the service's own output, said the public feed "carries no block tag". It does —
`block_trade_id` and `block_trade_leg_count`, plus `block_rfq_id` on ETH — so block trades are
identifiable, and that justification was simply false.

The obstacle is attribution, not tagging. A trade's reported direction names the side it was booked
from, not whether a dealer was the buyer or the seller, and nothing in the feed says whether a block
maker is a dealer at all. Since block-tagged trades are a large share of volume — **48.9% of BTC and
30.2% of ETH option contract volume** in a 200-trade window sampled 27 July 2026 — a flow-based sign
would be invertible on exactly the largest trades. GEX is a positioning map under a stated
convention, not measured inventory.

### 4. [structural] The variance risk premium is not statistically significant

At the honest effective sample the p-value is 0.254. Probabilities that depend on it are marked
indicative; the raw risk-neutral figures, which do not, are the ones to trust. The service computes
the premium and then declines to sell it.

### 5. [scheduled] One-touch barrier prices use a single volatility

A path-dependent barrier is not smile-consistent under any single volatility. What ships is the
honest width of the approximation — the model-uncertainty span between the barrier and at-the-money
volatilities. The rigorous treatment here is a vanna-volga overhedge from three vanilla quotes the
service already has, which makes this unbuilt work rather than a property of the market.

### 6. [scheduled] Transaction simulation is single-transaction and single-block

It prices one call at one block. Two of the three things this item used to bundle together are not
blocked at all: the adapter already speaks `eth_simulateV1`, which *is* a bundle simulator, and the
array it passes simply has one element. Measured against the first public RPC in the service's own
list, with no key: a three-call bundle carried state between calls (an allowance moving 0 → 1,000,000
across an `approve` in the middle), `stateOverrides` were accepted, and a two-block simulation ran.
Multi-transaction bundles and custom state overrides are therefore unbuilt work, not a missing
capability.

What remains genuinely out of reach for a stateless HTTP service is the MEV half: sandwich exposure
needs a view of the pending mempool, which this service does not have and will not fabricate.
Separately, spender reputation uses reachable on-chain signals; a verified-source check and an
approval graph would need an indexer that is not wired.

### 7. [structural] The exchange tape can be a sampled feed

For a hot token the DEX trade endpoint returns a large-trade subset rather than the full tape, which
weakens tick-level impact estimates. The service surfaces a tape-density diagnostic so this is
visible, and reports Kyle's lambda with a confidence label.

### 8. [scheduled] The macro calendar is curated and will age

Events are a hardcoded table transcribed from published Federal Reserve, BLS and BEA schedules, which
makes the service deterministic and free of an upstream that can fail mid-call — a deliberate trade,
but a trade. Past the last transcribed release it does not report a clear window: it returns
`CALENDAR_EXHAUSTED`, a third verdict distinct from both `CLEAR` and `EVENTS_AHEAD`, alongside
`certified: false` and a note saying that absence of events beyond the horizon is unknown rather than
clear. A caller can therefore tell "nothing is scheduled" from "I cannot see that far" — the
distinction that matters to anything trading around a release.

### 9. [structural] None of this is financial advice

The services report what markets price and what data shows. A not-advice disclosure ships on ten of
the thirteen observation services and on none of the nine deterministic risk engines — this section
used to claim every output touching a decision carried one, which was measured false on both
surfaces, and the nine engines it is most obviously wrong about are the risk gates. The short-window
up/down service refuses to output a directional edge at all, because short-horizon direction is
empirically indistinguishable from a coin flip.

### 10. [scheduled] Hosting is single-region with no redundancy

One container, one region, trial tier. The record is published rather than promised: over the
measured window, **99.63% of cycles clean (3,508 of 3,521)**, with four isolated single-cycle blips
that cleared on the next cycle and nine consecutive failures spanning one genuine outage of about
eighteen minutes on 24 July 2026, during which the platform edge accepted TLS but returned no bytes.

Two consequences are worth stating plainly. During such an outage Quiver cannot explain itself — the
component that would apologise is the unreachable one — which is why the availability record is
served from [separate infrastructure](https://cgn9npwmm0.execute-api.us-east-1.amazonaws.com/). And a
watchdog on that same external infrastructure now probes twice a minute and restarts the deployment
on two consecutive failures; the restart was *measured* to be graceful, and its heal path was
deliberately exercised end to end rather than assumed. It cannot help when the platform's own edge or
region is broken. Cross-region redundancy needs a custom domain, and the endpoint registered on chain
is the platform subdomain — changing it is a registry update, so that work is sequenced rather than
rushed.

---

## Known measurement gaps, stated because a limitation nobody names is the dangerous kind

- **Concurrency, partly closed.** Eighty paid calls in bursts of 2, 3, 6 and 12 simultaneous requests:
  settlement accounting held *exactly* at every level — 0.490000 claimed against 0.490000 moved,
  forty-nine settlements each confirmed individually on chain, nothing charged twice, nothing charged
  without an answer. Delivery degrades: every request served at two and three concurrent, 8 and 9 of
  12 at six, 24 of 48 at twelve, with every undelivered call costing exactly zero. The cause is **not
  isolated** between our client's concurrent signing, the payment rail, and this service, so reading
  it as "the service handles three concurrent callers" is unsupported. And it is one payer identity,
  so between-payer isolation is still untested.
- **The crash study validates the quantity, not our arithmetic on it.** The flag reads the venue's own
  published liquidation price; it never calls `perp-gate`. See [verification](verification.md).
- **External recurrence is small, not absent — and the earlier claim that it was zero was wrong.** Six payer addresses that are not ours sent 44 payments over the eight days to 27 July 2026, and four of the six paid more than once. The zero came from an in-memory counter that resets on every deploy; the corrected figure is recomputable from the USD₮0 transfer log on X Layer and needs nothing from us.
