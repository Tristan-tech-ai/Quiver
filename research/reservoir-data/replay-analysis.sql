-- "Would the gate have saved you?" — POPULATION-GRADE replay of the Oct-10-2025 cascade.
-- Data: Hydromancer Reservoir (s3://hydromancer-reservoir, requester-pays) daily perp position snapshots:
--   perp/all/date=2025-10-09 (T-24h: block 757690000, 2025-10-09 ~20:52 UTC, 227,157 positions, 79,386
--   accounts, $14.62B notional — matches Hyperliquid's known pre-crash OI) and date=2025-10-10 (T-6min:
--   ~20:44:54 UTC, minutes before the ~20:50 cascade). Fields per position: user, market, size (signed),
--   notional, entry_price, liquidation_price (the VENUE's own — cross-margin pooling already embedded),
--   leverage, leverage_type, account_value.
-- Victims: the 4,426-wallet census from the HLP backstop vault's liquidation-tagged fills (victims-merged.json).
-- Betas: MEASURED Oct-10 crash betas (HL 4h peak-to-trough ÷ BTC −17.7%); unlisted → 3.5 alt-median.
-- Definition: a position's down-kill = (its venue-liq distance %) ÷ beta(market) = the MARKET down-move that
-- liquidates it; an ACCOUNT's downKill = min over its LONG positions (a down-crash harms longs; shorts gain).
-- Run: duckdb < replay-analysis.sql   (from this directory; adjust the victims path if moved)

CREATE TEMP TABLE victims AS SELECT DISTINCT lower(tf."user") AS victim
FROM (SELECT unnest(taggedFills) AS tf FROM read_json_auto('victims-merged.json'));

CREATE TEMP TABLE beta (m VARCHAR, b DOUBLE);
INSERT INTO beta VALUES ('BTC',1.0),('ETH',1.5),('BNB',2.1),('SOL',2.2),('ZEC',3.1),('XRP',3.3),('LTC',3.6),
 ('ADA',3.8),('DOGE',3.8),('LINK',3.8),('AVAX',4.1),('POPCAT',4.1),('CRV',4.3),('PUMP',4.4),('ENA',4.4),
 ('LDO',4.5),('WIF',4.6),('kBONK',4.6),('PENGU',4.7),('SUI',4.7),('FARTCOIN',4.9),('AI16Z',5.0);

CREATE OR REPLACE TEMP MACRO downkill(f) AS TABLE
WITH pos AS (
  SELECT lower("user") u, market, size, notional/abs(size) AS mark, liquidation_price AS liq,
         CASE WHEN size>0 THEN 1 ELSE -1 END s
  FROM query_table(f) WHERE abs(size)>0 AND notional>0),
d AS (
  SELECT u, s, CASE WHEN liq IS NULL OR liq<=0 THEN NULL              -- no liq price = effectively unliquidatable buffer
       WHEN s=1 THEN GREATEST((mark-liq)/mark*100, 0)
       ELSE GREATEST((liq-mark)/mark*100, 0) END / COALESCE(b, 3.5) AS killMove
  FROM pos LEFT JOIN beta ON beta.m = pos.market)
SELECT u, MIN(CASE WHEN s=1 THEN COALESCE(killMove,1e9) ELSE 1e9 END) AS downKill FROM d GROUP BY u;

CREATE TEMP TABLE t24 AS SELECT * FROM downkill('perp_date=2025-10-09_757690000_1760040731430.parquet');
CREATE TEMP TABLE t6m AS SELECT * FROM downkill('perp_date=2025-10-10_758750000_1760126694218.parquet');

-- (1) Victims vs the rest at T-24h
SELECT 'T24h' AS snap, (v.victim IS NOT NULL) AS wiped, COUNT(*) accounts,
  ROUND(MEDIAN(CASE WHEN downKill<1e8 THEN downKill END),1) AS median_downKill_pct,
  ROUND(100.0*SUM(CASE WHEN downKill<=17.7 THEN 1 ELSE 0 END)/COUNT(*),1) AS pct_RED_at_17_7,
  ROUND(100.0*SUM(CASE WHEN downKill>=1e8 THEN 1 ELSE 0 END)/COUNT(*),1) AS pct_no_down_risk
FROM t24 LEFT JOIN victims v ON v.victim=t24.u GROUP BY 2
UNION ALL
SELECT 'T6min', (v.victim IS NOT NULL), COUNT(*),
  ROUND(MEDIAN(CASE WHEN downKill<1e8 THEN downKill END),1),
  ROUND(100.0*SUM(CASE WHEN downKill<=17.7 THEN 1 ELSE 0 END)/COUNT(*),1),
  ROUND(100.0*SUM(CASE WHEN downKill>=1e8 THEN 1 ELSE 0 END)/COUNT(*),1)
FROM t6m LEFT JOIN victims v ON v.victim=t6m.u GROUP BY 2 ORDER BY snap, wiped DESC;

-- (2) Relative risk of the RED flag at T-24h
SELECT (downKill<=17.7) AS gate_RED_T24h, COUNT(*) n, SUM(CASE WHEN v.victim IS NOT NULL THEN 1 ELSE 0 END) wiped_n,
  ROUND(100.0*SUM(CASE WHEN v.victim IS NOT NULL THEN 1 ELSE 0 END)/COUNT(*),2) AS pct_subsequently_wiped
FROM t24 LEFT JOIN victims v ON v.victim=t24.u GROUP BY 1 ORDER BY 1 DESC;

-- (3) Dose-response by distance band at T-24h (census wipe-rate per band)
SELECT CASE WHEN downKill<5 THEN '1: <5%' WHEN downKill<10 THEN '2: 5-10%' WHEN downKill<17.7 THEN '3: 10-17.7%'
            WHEN downKill<1e8 THEN '4: >17.7%' ELSE '5: no down-risk' END AS band,
  COUNT(*) accounts, SUM(CASE WHEN v.victim IS NOT NULL THEN 1 ELSE 0 END) wiped,
  ROUND(100.0*SUM(CASE WHEN v.victim IS NOT NULL THEN 1 ELSE 0 END)/COUNT(*),2) AS pct_wiped_in_census
FROM t24 LEFT JOIN victims v ON v.victim=t24.u GROUP BY 1 ORDER BY 1;

-- (4) Censoring check: attrition (gone from the book) between T-24h and T-6min, by band
SELECT CASE WHEN t24.downKill<5 THEN '1: <5%' WHEN t24.downKill<10 THEN '2: 5-10%' WHEN t24.downKill<17.7 THEN '3: 10-17.7%'
            WHEN t24.downKill<1e8 THEN '4: >17.7%' ELSE '5: no down-risk' END AS band_at_T24h,
  COUNT(*) accounts, ROUND(100.0*SUM(CASE WHEN t6m.u IS NULL THEN 1 ELSE 0 END)/COUNT(*),1) AS pct_gone_by_T6min
FROM t24 LEFT JOIN t6m ON t6m.u=t24.u GROUP BY 1 ORDER BY 1;
