# Quiver — Technical Documentation — part 5 of 7

> The complete document, split only because a single fetch truncates. **Nothing is abridged**: the
> parts below concatenate to the whole text, cut at section boundaries. Every part is served as plain
> markdown.
>
> - **Part 1** — `/paper/1` — Abstract  |  At a Glance  |  Contents  |  1. Introduction  |  2. System Architecture  |  3. Design Principles
> - **Part 2** — `/paper/2` — 4. Service Catalogue
> - **Part 3** — `/paper/3` — 5. Methodology
> - **Part 4** — `/paper/4` — 6. Verification and Testing  |  7. Worked Walkthrough  |  8. Limitations and Honest Disclosures
> - **Part 5** — `/paper/5` — 9. Related Work and Positioning  |  10. The Build: Story, Process, and a User Scenario
> - **Part 6** — `/paper/6` — 11. Roadmap: Operating Quiver After the Hackathon  |  12. Conclusion
> - **Part 7** — `/paper/7` — Appendix A · API Reference  |  Appendix B · Reproducibility  |  Appendix C · Checkable Artifacts  |  References
>
> Whole document in one response (249 kB, may truncate in your client): `/paper/full`
> Typeset edition with figures: `/paper`
> Live service: https://quiver-production-c3a8.up.railway.app · Source: https://github.com/Tristan-tech-ai/Quiver

---

## 9. Related Work and Positioning

Quiver sits at the intersection of three bodies of work: the agent-economy infrastructure that makes priced machine-to-machine services possible, the quantitative-finance methods the services implement, and the security tooling for on-chain transactions.

On infrastructure, x402 [27] supplies the payment rail, ERC-8004 [26] the identity and reputation layer, and the A2A and MCP conventions [28],[29] the calling and tool-exposure patterns. These standards define how agents pay and discover; they are deliberately silent on what is worth buying, which is the space Quiver occupies. Existing agent-registry services skew toward general assistants and simple data relays; a survey of the registry at build time found no service offering arbitrage-free options analytics, and the closest options-adjacent listings were not agent-callable.

On methods, the options stack rests on Black-76 [1], the Breeden–Litzenberger density [4], and the SVI surface of Gatheral with the no-arbitrage conditions of Gatheral and Jacquier [5],[6] and the wing bound of Lee [8]; the risk-neutral density literature [36] [37] [38] and its practitioner treatments inform the distribution layer. The microstructure estimators are Kyle [10], Amihud [11], and the VPIN of Easley, López de Prado, and O'Hara [12], with the square-root impact law [15] of Almgren and collaborators [13],[15] behind the fill service. The variance risk premium follows Bakshi and Kapadia and Carr and Wu [16],[17]. None of this is novel mathematics; the contribution is implementing it correctly, arbitrage-free, tested, and behind a priced agent interface, which is precisely what has not existed for agents before.

On security, the transaction path is a conventional simulation-and-decode pattern; the distinguishing element is the EIP-712 signature analysis [20],[21],[25], which addresses a vector that transaction-only tools cannot observe and that accounts for a large share of modern wallet losses [35].


## 10. The Build: Story, Process, and a User Scenario

This section steps back from the specification to tell how Quiver was built, what was learned along the way, and how the pieces are meant to be used together. The engineering record is part of the argument, because the decisions and the corrections are what a specification cannot show.


### 10.1 Starting from a gap

The project began with one observation. Agents had just gained the ability to pay for a service in-band over HTTP, and almost nothing worth paying for existed on the other side of that payment. We looked at what an autonomous trading or wallet agent needs at the moment it acts, and the list was concrete: the real probability that a price level is reached, the true cost of a size against real depth, a verdict on a signature before it is signed. None of it was available in a form an agent could call and trust. That gap set the direction. The decision that followed was to build computations a desk would recognise rather than another data relay, since a relay adds nothing an agent could not fetch for itself.


### 10.2 Choosing the set

Not every candidate survived. We held ideas to a floor: a real recurring need, an identifiable caller, and durability past the moment of a demo. Anything that depended on a fad, or that dressed a single API call as a product, was dropped. What remained clustered into the twenty-two services of Section 4. Options analytics was chosen as the widest moat, because the mathematics is unforgiving and the registry held no options service; a wrong volatility surface is worse than none, so getting it right is itself a barrier. Transaction safety was chosen for the opposite reason, that it is the highest-frequency and highest-stakes decision an agent makes, and the signature-drainer vector was covered by nobody. The rest fill out the surfaces an agent touches inside a loop: the tape, the book, the protocol, and the calendar. The most recent additions came from taking that floor seriously rather than from adding surface — the concentrated-liquidity desk earns its place by *refusing* to sell the optimiser the floor cannot justify, and reports the measurement instead; the authenticity scans exist because a number an agent trades on should be auditable back to the wallets and trades that produced it.


### 10.3 Holding a standard, and what it caught

The standard was set higher than a demo needs, on the principle that a financial service is judged by its worst number rather than its best. Early on, that principle paid for itself. The textbook probability formula, `N(d₂)`, was the first thing we reached for and the first thing we caught: on a skewed smile it is biased, and the bias was measured against a numerical density before the formula was replaced. The volatility surface took two attempts. A single global surface across all maturities was tried first and rejected by its own error gate, which was the right outcome; the literature prescribes fitting each expiry, and the second attempt did that and passed. The variance risk premium looked real until it was tested at the honest sample size, at which point it was not, and the service was made to say so.

The sharpest lessons came from pointing finished code at live markets. An illiquidity estimator that passed every synthetic test returned a value of order 10^9 on a real memecoin, because a live tape carries sub-cent dust the tests never imagined. A proxy detector that correctly handled the modern standard reported USD Coin, one of the most famous proxies in existence, as not a proxy, because USDC predates the standard and hides its implementation in an older slot. Each defect was invisible until the code met reality, and each one changed the implementation. The habit hardened into a rule that governs the whole project: build the thing, then point it at the market and believe the market over the code. Table 3 in Section 6 is the ledger of what that rule caught.


### 10.4 The record, dated

The project was built inside the OKX.AI Genesis window (July 2–28, 2026), and the dates below are taken from the on-chain record and the project's append-only engineering log, not from memory.

**July 12.** Agent #5152 is registered on X Layer under the name *Veritape* — at that point an authenticity-forensics service: wash-trade detection on token tapes, statistical audits of wallet track records, market-microstructure reads. The instinct was right (agents need numbers they can audit) but the frame was narrow.

**July 17.** The schedule had submissions closing that night, and the second version is shipped against that clock in one push: fourteen services, and four live defects in the volatility-surface fitter found and fixed the same day. That evening, OKX extends the Genesis window itself — the official schedule now runs to July 28. Eleven unexpected days changed the plan from "ship what exists under the gun" to "make the one existing entry worth judging": a single submission, levelled upward day after day, rather than a second one.

**July 18.** The day of self-audit. Before asking the platform to re-review anything, every service is audited for the failure class we had learned to fear most — the verifier that cannot fail — and the audit finds one more (an arbitrage check that scanned 14% of a smile and reported success). The catalogue is also curated: an off-theme service is withdrawn from the listing, and the original forensics services are kept because they fit the thesis that was forming.

**July 19.** The pivot, committed on-chain. The listing's description is rewritten to *"the verifiable risk brain for autonomous agents"* and nine deterministic risk engines are added — `perp-gate`, `size-gate`, `exec-verify`, `options-risk`, `portfolio-gate`, `lp-risk`, `treasury-risk`, `event-vol`, `risk-attest` — taking the catalogue from thirteen to twenty-two, with the cross-venue portfolio engine following as the twenty-second the same day. The reasons were two ground truths, not taste. First, the data-relay end of the agent-services market was commoditizing in real time: wrapper feeds were multiplying and a large share of observable payment volume was self-dealing, so "another API" had no durable value. Second, the durable gap was the one October 10, 2025 had exposed — agents and the risk products around them enforce *limits*, but nothing *computes* the numbers those limits are checked against, correctly and provably. Veritape's forensics did not die in the pivot; they became the authenticity services inside the risk brain. The same day, the first real settlement is proven on the second payment rail (a signed USDC payment on Base, verified on-chain).

**July 20.** The verifiability claim is made literal: an attestation schema is registered on Base EAS and the first batch of proof hashes is anchored under it. An adversarial review is run against our own live surface, simulating the platform's reviewer; it passes with notes, and all seven findings are fixed the same day. The service is published on the official MCP registry. The platform's human reviewer replies with a single request — the avatar should be a square — and the fix is on-chain within hours.

**July 21.** The listing goes live: all twenty-two services approved. What follows is the deepest day of the project: a systematic audit of every service against live data (about fourteen defects found and fixed, each locked by a test that fails on the pre-fix code), signed observation envelopes added to every live-data answer, the account-mode portfolio engine with the venue's own liquidation prices as an external cross-check, and — the part this paper leans on — the crash census, the population-scale replay from the venue's position archive, the pre-registered out-of-sample validation of Section 6, and a field test in which every service was purchased end-to-end with real money on both rails. A second adversarial review pass that day caught the project wearing the wrong envelope on one new feature (a deterministic "proof" over a live fetch); it was corrected, and the correction is owned in Section 5 rather than hidden.

The pattern across those ten days is the one this section keeps returning to: every date pairs a thing built with a thing caught — often caught in our own work, by our own checks, on the same day. That is not an embarrassment to disclose; it is the product working on itself.


### 10.5 A day in an agent's loop

The services are designed to be used together, and the clearest way to see the product is to follow one agent through a single decision. Consider a trading agent that has resolved to take a directional position and is about to size it and sign for it.

1. It calls `options-desk` and reads the risk-neutral distribution, checking whether the market already prices the move it expects and at what probability, so it is not paying for a move the options market considers likely.
2. It calls `poly-fill`, or reads the options expected move, to learn what its intended size will actually cost against live depth rather than against a midpoint that a thin book makes fictional.
3. It checks `macro-sentry` so it does not size into a scheduled print, and reads `tape-pulse` to see whether current flow is one-sided against it.
4. Having sized the trade, it constructs the approval and, before signing, passes the unsigned transaction and any permit signature to `calldata-x`. An unlimited approval to an unrecognised wallet returns a danger verdict and stops the loop; a routine approval to a known router passes.
5. On the next iteration it calls `loop-digest` with its cursor and reads only what changed, instead of re-fetching and re-paying for the entire state.

Each call costs half a cent to five cents, cheap enough to sit inside the loop, and each returns a number the agent can act on because the number can be checked. A market read, an execution cost, and a safety gate, all callable and all verifiable in one loop, is what Quiver is for.

---

**Continues in part 6 of 7: `/paper/6` — 11. Roadmap: Operating Quiver After the Hackathon  |  12. Conclusion**
