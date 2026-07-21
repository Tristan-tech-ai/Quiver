# Would the gate have saved you? — a leverage census of the Oct-10-2025 liquidation cascade

*A Quiver empirical study. Every number traces to a public on-chain source; the whole thing is re-pullable
keyless. This is the Creative-Genius artifact: not a claim the tool makes, a measurement of the world that
motivates it. Produced Jul 21 2026 during the autonomous optimization marathon.*

## The question

On **Oct 10 2025**, a correlated crash liquidated **$19.1B** across crypto — the largest deleveraging ever;
Hyperliquid alone force-closed **>$10B** across **6,300 wallets** (205 lost >$1M each), its first ADL in two
years (sources: CoinDesk, CNBC, Amberdata; BTC −14%, ETH −12%, SOL −40% in the cascade window ~20:50 UTC).
Quiver's `perp-gate` / `portfolio-gate` exist to tell an agent, *before* it opens or holds a position, how
close it sits to liquidation and whether a correlated stress wipes multiple legs at once. So: **for the
people who actually blew up, how close to the edge were they — and would the gate have shown it?**

## Data (all public, all re-pullable, keyless)

- **Victim census.** Hyperliquid's liquidation engine runs through HLP child vaults. Sweeping all 7 across
  the crash window (Oct 10 12:00 → Oct 11 12:00 UTC) via the public `info/userFillsByTime` API, one vault
  (`0xb0a55f13…`) carried the liquidations: **10,030 liquidation-tagged fills → 4,426 distinct liquidated
  wallets, $2.645B of tagged notional** (~70% of the reported 6,300 wallets — population-scale, no paid data).
  Each tagged fill carries `liquidation.liquidatedUser` and the liquidation mark price.
- **Position reconstruction.** For a stratified sample of **500 victims** (top-300 by liquidated notional +
  200 seeded-random), we pulled each wallet's fills for the **7 days before** the cascade. HL fills carry
  `startPosition` (the signed position *before* the fill), so the position standing at cascade start is
  rebuilt exactly from the last pre-crash fill per coin. 329/500 had pre-window fills; **246 positions** were
  cleanly reconstructable (both an entry proxy and an on-chain liquidation price, side-consistent).

## The measurement (non-circular by construction)

For each reconstructed position we compute one number: the **% move from entry to the liquidation price**,
where *entry* = the last pre-crash trade price and *liq* = the on-chain liquidation-event mark. **No margin
is assumed** — both quantities are observed. (An earlier pass inferred margin from the liq price and fed it
back into `perp-gate`; that is circular — the gate just echoes the number you gave it — and was discarded.
This distance measurement needs nothing but the two observed prices.)

## Result

| Liq-distance from entry | value |
|---|---|
| p10 | 11.6% |
| p25 | 14.2% |
| **median** | **20.2%** |
| p75 | 24.4% |
| p90 | 31.5% |

**Share of liquidated positions whose liquidation price sat within a given adverse move of entry:**

| within… | share |
|---|---|
| 10% | 5.3% |
| **14% (the BTC crash)** | **23.6%** |
| **20% (correlated-stress band)** | **50.0%** |
| 40% (the SOL crash) | 99.2% |

Per-coin median liq-distance: **BTC 12.5%**, ETH 20.8%, XRP 25.0%, SOL 27.7%.

## What it says

**The median liquidated position sat just 20% from its liquidation price when it was opened — and half were
inside the very move the crash delivered.** This isn't a story about a reckless tail: the *middle* of the
distribution was one correlated stress-move from ruin. BTC longs were the tightest (median 12.5%, *inside*
the 14% BTC drop) — majors get the highest leverage, so they liquidate first, exactly what `portfolio-gate`'s
"which leg liquidates first" is built to surface.

`perp-gate`'s entire output is this distance, computed in real time from the trader's own margin (which they
have). The census doesn't prove the gate is clairvoyant — it proves the number the gate reports was already
in the red zone for the majority who blew up. **A gate that says "your liquidation is 12% away, and a
correlated -20% is on the table" is not a nicety; for 50% of Oct-10's victims it was the whole story.**

## Honesty ledger (what this is NOT)

- Entry = last pre-crash **trade price**, not the position's VWAP — a proxy that *understates* distance for
  positions already underwater, so the shares above are a **lower bound**.
- Isolated margin is assumed; cross-margin accounts have a different true buffer and are mislabeled.
- 171/500 sampled wallets opened their positions >7 days before the crash (no pre-window fills) and are
  **excluded, not counted as safe** — widening the window would only add more positions, not remove the finding.
- The liq price is the earliest on-chain liquidation-event mark for that wallet+coin.

## Reproduce

Scripts (keyless, resume-able): `scratchpad/crash-replay/{sweep-vaults, harvest-victims, distribution}.mjs`.
Vault `0xb0a55f13d22f66e6d495ac98113841b2326e9540`, window Oct 10 12:00–Oct 11 12:00 UTC, `info/userFillsByTime`.
Re-pull the fills, recompute the two prices per position, and the distribution reproduces. That is the point:
like every Quiver answer, the claim is re-derivable, not trusted.

---

## Extension: measured crash-betas (feeds portfolio-gate's stress model)

The same Oct-10 data yields a second artifact: **per-coin crash beta** = coin peak→trough ÷ BTC peak→trough,
measured from Hyperliquid 4h candles (BTC −17.7% anchor), keyless-reproducible
(`scratchpad/crash-replay/measure-betas-hl.mjs`).

| coin | crash DD | β vs BTC | | coin | crash DD | β vs BTC |
|---|---|---|---|---|---|---|
| BTC | −17.7% | 1.0 | | LTC | −64% | 3.6 |
| ETH | −26% | 1.5 | | ADA/DOGE/LINK | −64…67% | 3.8 |
| BNB | −37% | 2.1 | | AVAX/POPCAT | −73% | 4.1 |
| SOL | −39% | 2.2 | | CRV/PUMP/ENA/LDO | −76…79% | 4.3–4.5 |
| ZEC | −55% | 3.1 | | WIF/kBONK/PENGU/SUI | −81…83% | 4.6–4.7 |
| XRP | −59% | 3.3 | | FARTCOIN/AI16Z | −87…89% | 4.9–5.0 |

**Why it matters (and a discipline note):** a first-pass GUESS table (ETH 0.9, SOL 2.6, alts ~2–3) understated
alt beta **2–3×**; measuring against the real prices corrected it — the "verifier the model does not control."
These betas now default `portfolio-gate`'s `betaScaledStress`, so a book of high-beta alts is stressed
realistically: on the live BTC+LINK example, an 8% market drop liquidates the LINK leg (β 3.8 → 30% asset
move) that the naive ρ=1 model misses. **Caveat, disclosed in the service:** these are SEVERE crash-regime
betas that include liquidation-cascade feedback on thin books (the reflexive spiral the stress warns about) —
for a milder correlated move, pass lower per-asset betas.

---

# Part 2 — the population-grade replay: REAL positions, REAL margins, the whole exchange (Jul 21 2026)

*Part 1 measured liq-distances for 246 reconstructed victims with a disclosed weakness: entries were proxies
and margins assumed. Part 2 removes both. Source: the Hydromancer Reservoir public S3 archive
(`s3://hydromancer-reservoir`, requester-pays — total data cost of this study: ≈ $0.01) carries DAILY
snapshots of EVERY open perp position on Hyperliquid: user, market, signed size, notional, entry, leverage,
margin mode, and the VENUE'S OWN liquidation price (cross-margin pooling already embedded). Two snapshots
bracket the cascade: **T-24h** (Oct 9 ~20:52 UTC — 227,157 positions, 79,386 accounts, $14.62B notional,
matching Hyperliquid's known pre-crash open interest) and **T-6min** (Oct 10 ~20:44:54 UTC, minutes before
the ~20:50 cascade). Reproduce: `reservoir-data/replay-analysis.sql` (DuckDB, self-contained).*

## The metric

For each position, its **down-kill** = (venue liq-distance %) ÷ β(market) — the market-wide down-move that
liquidates it, using the measured crash betas above. An **account's** down-kill = the minimum over its LONG
positions (a down-crash harms longs; shorts gain). "RED" = down-kill ≤ 17.7%, the BTC peak-to-trough that
then actually happened. This is exactly the number `portfolio-gate`'s beta-scaled stress reports, evaluated
on the venue's own liquidation prices — no margin inference anywhere.

## Results

| cohort | accounts | median down-kill | RED at T-24h | RED at T-6min |
|---|---|---|---|---|
| **census victims** | 3,554 (of 4,426; $2.08B notional) | **9.5%** market move | **79.7%** | **86.2%** |
| everyone else | 75,832 | 6.8% (37% had NO down-risk) | 49.1% | 48.0% |

**Relative risk:** accounts flagged RED at T-24h were subsequently census-wiped at **7.07%** vs **1.83%**
for non-RED — a **3.9×** separation from one number computed a day early.

**Dose-response with a censoring twist (the sharpest finding).** Census wipe-rate by T-24h distance band:

| down-kill band at T-24h | accounts | census wipe-rate | gone from book by T-6min |
|---|---|---|---|
| <5% | 19,491 | 4.7% | **30.8%** |
| 5–10% | 12,090 | 6.5% | 11.4% |
| **10–17.7%** | **8,457** | **13.5%** | 6.9% |
| >17.7% | 10,687 | 3.3% | 5.9% |
| no down-risk | 28,661 | 1.3% | 9.1% |

The curve is non-monotonic **and the deviation is itself informative**: the <5% cohort dies young — 30.8%
of it was already gone from the book before the cascade (routine volatility liquidates or scares out the
near-edge crowd; those deaths go through the ordinary book path, which this census — built from the
backstop vault — does not tag). The **10–17.7% band is the cascade's harvest**: positions safe under normal
volatility, reachable ONLY by a correlated crash — census-wiped at **13.5%, 7.4× the rate of everyone
further out (1.8%)**. That band is precisely the population a correlated-stress warning uniquely protects:
routine risk tools (and the trader's own experience of surviving normal days) say they're fine; the
beta-scaled stress said otherwise, 24 hours early.

## Honesty ledger (Part 2)

- The census tags the **backstop-vault** liquidation path (4,426 of ~6,300 wiped wallets, ~70%); ordinary
  book-path liquidations are not tagged, so band wipe-rates are lower bounds and the <5% band is the most
  censored — the attrition column makes that censoring visible instead of hiding it.
- The scenario is **down-only** (longs). Shorts wiped in the post-cascade whipsaw/ADL appear in the
  "no down-risk" band's 1.3%, not as scenario hits.
- Betas are the severe crash-regime measurements (cascade feedback included) — the exact regime being
  replayed, so appropriate here; for milder stresses they overstate.
- The venue liquidation price embeds cross-margin pooling, so hedged cross accounts are treated correctly;
  isolated positions use their own margin, as the venue computes them.
- 872 census victims had no open positions at T-24h (opened later, or spot/vault-only exposure) — excluded,
  not counted either way.

**Bottom line: with every position and every real margin on the exchange, the gate's number — computed a
full day before the largest liquidation event in crypto history — separated the wiped from the survivors
by 3.9×, and identified the specific cohort (10–17.7% band) whose destruction was uniquely foreseeable.**

---

# Part 3 — pre-registered cross-event validation (the anti-overfitting test), Jul 21 2026

*Part 2's one honest weakness: the betas were measured on the same event they were validated against. Part 3
removes it with the strictest protocol we know: hypotheses, thresholds, data definitions and the pass/fail
rule were **written into the append-only mission log BEFORE any validation number was computed**, with a
hard temporal cutoff. Nothing was tuned after seeing results; results are reported pass or fail.*

## Setup

- **Episodes.** 34 stress episodes detected across the archive window (Jul 2025 → Jul 2026) from free HL 4h
  BTC candles (rolling 48h peak→trough ≥5%): 4 severe, 9 moderate, 21 mild — including Feb-2026 (−32.8%
  over its full window, deeper than Oct-10) and Jun-2026 (−17.2%).
- **Cutoff 2025-12-31.** Calibration = 2025 episodes only; validation = 2026 episodes only.
- **Calibration artifact:** per-asset beta = median per-episode (asset dd ÷ BTC dd) over calibration
  episodes, in three severity tiers (mild <8% BTC dd: 9 episodes; moderate 8–12%: 3; severe ≥12%: 2).

## H1 — do calibration betas predict future episodes' risk ranking? (registered PASS bar: median Spearman ≥ 0.6)

Spearman rank-correlation between calibration betas and each 2026 ≥8% episode's realized betas (21 assets):

| 2026 episode | BTC dd | Spearman |
|---|---|---|
| Jan-29/Feb-13 | 32.8% | 0.67 |
| Mar-06 | 8.2% | 0.775 |
| Mar-26 | 8.2% | 0.657 |
| Jun-02/07 | 17.2% | 0.53 |
| Jun-23 | 9.6% | 0.65 |

**Median = 0.657 ≥ 0.6 → PASS.** The per-asset risk ordering measured in 2025 still held in 2026.

## H2 — does the kill-move flag work on a crash it has never seen? (registered PASS bar: relative risk ≥ 1.5)

Event: the **Jun-2026 crash** (post-cutoff). Snapshot T-24h (Jun-03, 100,034 accounts); down-kill computed
with **calibration-only betas**; RED = down-kill ≤ the registered threshold. Victims: **censoring-free** —
16,492 addresses with Long-side liquidation fills in the full raw fill stream (every liquidation path, not
just the backstop vault).

| flag at T-24h | accounts | subsequently liquidated |
|---|---|---|
| RED | 43,807 | **25.37%** |
| not RED | 56,227 | **1.78%** |

**Relative risk = 14.3× ≥ 1.5 → PASS.** And with censoring removed, the dose-response is perfectly
monotonic: <5% band 40.9% wiped → 5–10%: 11.6% → 10–13.6%: 3.2% → beyond: 0.8% — which also confirms
Part 2's censoring interpretation of the Oct-10 curve.

## H2b — a SECOND out-of-sample event (separately pre-registered): the Feb-2026 crash, the archive's deepest

Same protocol, registered before computing (snapshot rule, victim definition, RED ≤ 21.88 the
detection-time dd, PASS bar RR ≥ 1.5). Snapshot used per the registered rule: date=2026-02-05, timestamp
00:10 UTC = T-23.8h before the trough; 66,148 accounts; victims = 19,541 Long-liquidated addresses
(full raw fill stream, Feb-05/06).

| flag at T-23.8h | accounts | subsequently liquidated |
|---|---|---|
| RED | 27,539 | **43.97%** |
| not RED | 38,609 | **3.30%** |

**Relative risk = 13.3× → PASS.** Dose-response again perfectly monotonic (<5%: 69.6% → 5–10%: 40.4% →
10–21.9%: 22.7% → beyond: 2.4%). Two independent out-of-sample crashes, two pre-registrations, relative
risks 14.3× and 13.3× — the cross-event consistency is itself the robustness evidence.

## What shipped because of this (and only because both passed)

`portfolio-gate` now offers `betaTier: mild | moderate | severe` — the cross-validated regime estimates,
with the full validation record (`betaValidation`) in every response. The default remains the worst-case
single-event Oct-10 table, labeled as such. Explicit caller betas always win. Reproduce:
`reservoir-data/{detect-episodes.mjs, measure-betas-episodes.mjs, gen-h2.mjs, h2.sql}`; pre-registration
text in `QUIVER_MISSION_CONTROL.md` (append-only, timestamped before computation).

## Honesty ledger (Part 3)

- The calibration ≥8% episode list shifted slightly from the scouting expectation (episode-window dd vs
  detection-time rolling dd reclassified two episodes in, one out); the registered *rule* ("measured-window
  BTC dd ≥8%") was applied identically on both sides — disclosed, not silently absorbed.
- H2's victim window is the two trough days (data-cost cap, registered) — victims are a lower bound.
- H2 threshold was registered as 13.63 (detection-time dd); the full-window dd measured 17.24. The
  registered number was used. This makes RED *stricter*, not looser.
- One severe-tier caveat: only 2 calibration severe episodes exist; the tier is a median of two. More
  severe events will sharpen it — the measurement pipeline is now a repeatable script, not a one-off.
