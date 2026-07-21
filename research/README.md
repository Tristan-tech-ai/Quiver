# Research artifacts — the crash study, its validation, and the field test

Everything the whitepaper's Section 6.3 ("Validation against the real market") and the crash study claim
is reproducible from this folder plus public data. Nothing here is required to run the service; it is the
evidence trail.

## crash-study/

`QUIVER_CRASH_STUDY.md` — the full study in three parts: (1) the Oct-10-2025 victim census from public
Hyperliquid fills (keyless), (2) the population-scale replay over every open position on the venue
(real margins, the venue's own liquidation prices), (3) the **pre-registered, out-of-sample cross-event
validation** (hypotheses and thresholds committed to an append-only log before computing; relative risks
14.3× and 13.3× on the two 2026 crashes the calibration had never seen). Each part carries its own
honesty ledger.

## reservoir-data/

Scripts + small result files. The large inputs (daily position snapshots and raw fill parquets) are NOT
committed — they come from the public requester-pays S3 archive `s3://hydromancer-reservoir` (by
Hydromancer). Fetching the exact files used costs well under $1:

```
aws s3 cp s3://hydromancer-reservoir/global/snapshots/perp/all/date=2025-10-09/757690000_1760040731430.parquet . --request-payer requester
aws s3 cp s3://hydromancer-reservoir/global/snapshots/perp/all/date=2025-10-10/758750000_1760126694218.parquet . --request-payer requester
aws s3 cp s3://hydromancer-reservoir/global/snapshots/perp/all/date=2026-06-03/1020660000_1780445203938.parquet . --request-payer requester
aws s3 cp s3://hydromancer-reservoir/global/snapshots/perp/all/date=2026-02-05/884030000_1770250239629.parquet . --request-payer requester
aws s3 cp s3://hydromancer-reservoir/global/fills/raw/date=2026-06-03/fills.parquet fills_raw_2026-06-03.parquet --request-payer requester
aws s3 cp s3://hydromancer-reservoir/global/fills/raw/date=2026-06-04/fills.parquet fills_raw_2026-06-04.parquet --request-payer requester
aws s3 cp s3://hydromancer-reservoir/global/fills/raw/date=2026-02-05/fills.parquet fills_raw_2026-02-05.parquet --request-payer requester
aws s3 cp s3://hydromancer-reservoir/global/fills/raw/date=2026-02-06/fills.parquet fills_raw_2026-02-06.parquet --request-payer requester
```

Then, with DuckDB and Node ≥ 20 (no other dependencies):

- `node detect-episodes.mjs` — finds every stress episode in the archive window from free Hyperliquid 4h
  candles → `episodes.json` (34 episodes; committed).
- `node measure-betas-episodes.mjs` — measures per-episode betas and evaluates **H1** (beta
  transportability, 2025→2026, median Spearman 0.657 PASS) → `episode-betas.json`,
  `beta-calibration.json`, `h1-result.json` (committed).
- `duckdb < replay-analysis.sql` — the Oct-10 population replay (Part 2 numbers).
- `node gen-h2.mjs && duckdb < h2.sql` — **H2**, the Jun-2026 out-of-sample event (RR 14.3×).
- `duckdb < h2b.sql` — **H2b**, the Feb-2026 out-of-sample event (RR 13.3×).

`victims-merged.json` (committed) is the Oct-10 backstop-vault victim census, itself reproducible keyless
from the public Hyperliquid `info/userFillsByTime` API (vault `0xb0a55f13…9540`, window Oct 10 12:00 →
Oct 11 12:00 UTC).

The pre-registration texts (written before any validation number was computed) live in the project's
append-only engineering log; the registered thresholds are restated inside the study.

## field-test/

The buyer-side field test: every one of the 22 listed services purchased end-to-end with real money on
BOTH payment rails — USDC on Base via the CDP facilitator (`field-test.mjs`), and USD₮0 on X Layer via
the OKX facilitator, signed by an OKX agentic wallet's TEE (`okx-rail-test.mjs` + waves 2/3). Each call:
402 challenge → signed payment → on-chain settlement → independent recomputation of the response
envelope's content hash. Results JSONs are committed verbatim. These purchases are quality assurance,
not traction, and are never counted as sales.
