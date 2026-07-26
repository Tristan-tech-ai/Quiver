-- ABLATION: does beta-scaling carry the signal, or would raw distance-to-liquidation do the same?
-- The pre-registered flag is (distance to liquidation %) / (asset crash beta) <= threshold. A reviewer's
-- fair objection is that within a crash, accounts nearer liquidation liquidate — close to arithmetic —
-- so the reported relative risk needs a baseline that is not 1x. This runs the IDENTICAL pipeline twice,
-- once with the betas and once with beta forced to 1 for every market (i.e. raw distance), on the same
-- snapshot, the same victim set, and a threshold chosen to hold the flagged-population size comparable.
-- Jun-2026 event. Change the file names + threshold for Feb-2026 (see ablation-feb.sql).

CREATE TEMP TABLE beta (m VARCHAR, b DOUBLE);
INSERT INTO beta VALUES ('BTC',1),('ETH',1.39),('BNB',1.78),('SOL',1.71),('ZEC',2.17),('XRP',1.6),('LTC',1.56),('ADA',1.87),('DOGE',1.74),('LINK',2.1),('AVAX',1.94),('POPCAT',3.04),('CRV',1.77),('PUMP',2.42),('ENA',2.03),('LDO',2.39),('WIF',2.22),('kBONK',2.09),('PENGU',2.44),('SUI',2.13),('FARTCOIN',2.71),('AI16Z',3.29),('HYPE',1.7);

CREATE TEMP TABLE victims AS
SELECT DISTINCT lower(address) AS victim FROM read_parquet(['fills_raw_2026-06-03.parquet','fills_raw_2026-06-04.parquet'])
WHERE is_liquidation AND direction LIKE '%Long%';

-- Both measures for every account, from one pass over the same snapshot.
CREATE TEMP TABLE acct AS
WITH pos AS (
  SELECT lower("user") u, market, size, notional/abs(size) AS mark, liquidation_price AS liq,
         CASE WHEN size>0 THEN 1 ELSE -1 END s
  FROM 'perp_2026-06-03.parquet' WHERE abs(size)>0 AND notional>0),
d AS (
  SELECT u, s,
    CASE WHEN liq IS NULL OR liq<=0 THEN NULL
         WHEN s=1 THEN GREATEST((mark-liq)/mark*100, 0)
         ELSE GREATEST((liq-mark)/mark*100, 0) END AS rawMove,
    CASE WHEN liq IS NULL OR liq<=0 THEN NULL
         WHEN s=1 THEN GREATEST((mark-liq)/mark*100, 0)
         ELSE GREATEST((liq-mark)/mark*100, 0) END / COALESCE(b, 2.1) AS betaMove
  FROM pos LEFT JOIN beta ON beta.m = pos.market)
SELECT u,
  MIN(CASE WHEN s=1 THEN COALESCE(betaMove,1e9) ELSE 1e9 END) AS downKillBeta,
  MIN(CASE WHEN s=1 THEN COALESCE(rawMove ,1e9) ELSE 1e9 END) AS downKillRaw
FROM d GROUP BY u;

CREATE TEMP TABLE flags AS
SELECT a.*, (v.victim IS NOT NULL) AS wiped FROM acct a LEFT JOIN victims v ON v.victim=a.u;

-- The pre-registered beta-scaled threshold flags this many accounts; the raw threshold is set to the
-- quantile that flags the SAME NUMBER, so the two arms are compared at equal flagged-population size
-- rather than at an arbitrary cutoff that would let either arm look better by flagging more or fewer.
CREATE TEMP TABLE sizes AS
SELECT COUNT(*) FILTER (WHERE downKillBeta<=13.63) AS n_flagged, COUNT(*) AS n_total FROM flags;
SELECT * FROM sizes;

CREATE TEMP TABLE raw_thr AS
SELECT MAX(downKillRaw) AS thr FROM (
  SELECT downKillRaw FROM flags ORDER BY downKillRaw
  LIMIT (SELECT n_flagged FROM sizes));
SELECT thr AS raw_threshold_matched FROM raw_thr;

-- Arm A: beta-scaled (the pre-registered flag).
SELECT 'A_beta_scaled' AS arm,
  SUM(CASE WHEN downKillBeta<=13.63 THEN 1 ELSE 0 END) AS flagged,
  ROUND(100.0*SUM(CASE WHEN downKillBeta<=13.63 AND wiped THEN 1 ELSE 0 END)/NULLIF(SUM(CASE WHEN downKillBeta<=13.63 THEN 1 ELSE 0 END),0),2) AS pct_flagged_wiped,
  ROUND(100.0*SUM(CASE WHEN downKillBeta>13.63 AND wiped THEN 1 ELSE 0 END)/NULLIF(SUM(CASE WHEN downKillBeta>13.63 THEN 1 ELSE 0 END),0),2) AS pct_cleared_wiped,
  ROUND((1.0*SUM(CASE WHEN downKillBeta<=13.63 AND wiped THEN 1 ELSE 0 END)/NULLIF(SUM(CASE WHEN downKillBeta<=13.63 THEN 1 ELSE 0 END),0))
      / NULLIF(1.0*SUM(CASE WHEN downKillBeta>13.63 AND wiped THEN 1 ELSE 0 END)/NULLIF(SUM(CASE WHEN downKillBeta>13.63 THEN 1 ELSE 0 END),0),0),2) AS relative_risk
FROM flags
UNION ALL
-- Arm B: raw distance, no beta, threshold matched to flag the same number of accounts.
SELECT 'B_raw_distance' AS arm,
  SUM(CASE WHEN downKillRaw<=(SELECT thr FROM raw_thr) THEN 1 ELSE 0 END),
  ROUND(100.0*SUM(CASE WHEN downKillRaw<=(SELECT thr FROM raw_thr) AND wiped THEN 1 ELSE 0 END)/NULLIF(SUM(CASE WHEN downKillRaw<=(SELECT thr FROM raw_thr) THEN 1 ELSE 0 END),0),2),
  ROUND(100.0*SUM(CASE WHEN downKillRaw>(SELECT thr FROM raw_thr) AND wiped THEN 1 ELSE 0 END)/NULLIF(SUM(CASE WHEN downKillRaw>(SELECT thr FROM raw_thr) THEN 1 ELSE 0 END),0),2),
  ROUND((1.0*SUM(CASE WHEN downKillRaw<=(SELECT thr FROM raw_thr) AND wiped THEN 1 ELSE 0 END)/NULLIF(SUM(CASE WHEN downKillRaw<=(SELECT thr FROM raw_thr) THEN 1 ELSE 0 END),0))
      / NULLIF(1.0*SUM(CASE WHEN downKillRaw>(SELECT thr FROM raw_thr) AND wiped THEN 1 ELSE 0 END)/NULLIF(SUM(CASE WHEN downKillRaw>(SELECT thr FROM raw_thr) THEN 1 ELSE 0 END),0),0),2)
FROM flags;
