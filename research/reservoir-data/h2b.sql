
CREATE TEMP TABLE beta (m VARCHAR, b DOUBLE);
INSERT INTO beta VALUES ('BTC',1),('ETH',1.39),('BNB',1.78),('SOL',1.71),('ZEC',2.17),('XRP',1.6),('LTC',1.56),('ADA',1.87),('DOGE',1.74),('LINK',2.1),('AVAX',1.94),('POPCAT',3.04),('CRV',1.77),('PUMP',2.42),('ENA',2.03),('LDO',2.39),('WIF',2.22),('kBONK',2.09),('PENGU',2.44),('SUI',2.13),('FARTCOIN',2.71),('AI16Z',3.29),('HYPE',1.7);
CREATE TEMP TABLE victims AS
SELECT DISTINCT lower(address) AS victim FROM read_parquet(['fills_raw_2026-02-05.parquet','fills_raw_2026-02-06.parquet'])
WHERE is_liquidation AND direction LIKE '%Long%';
CREATE TEMP TABLE acct AS
WITH pos AS (
  SELECT lower("user") u, market, size, notional/abs(size) AS mark, liquidation_price AS liq,
         CASE WHEN size>0 THEN 1 ELSE -1 END s
  FROM 'perp_2026-02-05.parquet' WHERE abs(size)>0 AND notional>0),
d AS (
  SELECT u, s, CASE WHEN liq IS NULL OR liq<=0 THEN NULL
       WHEN s=1 THEN GREATEST((mark-liq)/mark*100, 0)
       ELSE GREATEST((liq-mark)/mark*100, 0) END / COALESCE(b, 2.1) AS killMove
  FROM pos LEFT JOIN beta ON beta.m = pos.market)
SELECT u, MIN(CASE WHEN s=1 THEN COALESCE(killMove,1e9) ELSE 1e9 END) AS downKill FROM d GROUP BY u;
SELECT (SELECT COUNT(*) FROM victims) AS victims_total, (SELECT COUNT(*) FROM acct) AS accounts_snapshot;
CREATE TEMP TABLE flags AS SELECT a.u, a.downKill, (v.victim IS NOT NULL) AS wiped FROM acct a LEFT JOIN victims v ON v.victim=a.u;
SELECT (downKill<=21.88) AS RED_registered_h2b, COUNT(*) n, SUM(CASE WHEN wiped THEN 1 ELSE 0 END) wiped_n, ROUND(100.0*SUM(CASE WHEN wiped THEN 1 ELSE 0 END)/COUNT(*),2) AS pct_wiped FROM flags GROUP BY 1 ORDER BY 1 DESC;
SELECT CASE WHEN downKill<5 THEN '1: <5%' WHEN downKill<10 THEN '2: 5-10%' WHEN downKill<21.88 THEN '3: 10-21.9%' WHEN downKill<1e8 THEN '4: >21.9%' ELSE '5: no down-risk' END AS band,
  COUNT(*) accounts, SUM(CASE WHEN wiped THEN 1 ELSE 0 END) wiped, ROUND(100.0*SUM(CASE WHEN wiped THEN 1 ELSE 0 END)/COUNT(*),2) AS pct_wiped
FROM flags GROUP BY 1 ORDER BY 1;

