// Generates h2.sql exactly per the pre-registration (victims = Long liquidations Jun-03/04; downKill from
// the Jun-03 snapshot with CALIBRATION-only betas; RED = downKill ≤ 13.63; relative risk + bands).
import fs from 'fs';
const cal = JSON.parse(fs.readFileSync(new URL('./beta-calibration.json', import.meta.url)));
const bc = cal.betaCal;
const entries = Object.entries(bc).filter(([, v]) => v != null);
const nonMajor = entries.filter(([k]) => !['BTC', 'ETH', 'BNB', 'SOL'].includes(k)).map(([, v]) => v).sort((a, b) => a - b);
const altMedian = nonMajor.length % 2 ? nonMajor[(nonMajor.length - 1) / 2] : (nonMajor[nonMajor.length / 2 - 1] + nonMajor[nonMajor.length / 2]) / 2;
console.log('beta_cal:', JSON.stringify(bc));
console.log('altMedian (non-major):', altMedian);
const vals = entries.map(([k, v]) => `('${k}',${v})`).join(',');
const sql = `
CREATE TEMP TABLE beta (m VARCHAR, b DOUBLE);
INSERT INTO beta VALUES ${vals};
CREATE TEMP TABLE victims AS
SELECT DISTINCT lower(address) AS victim FROM read_parquet(['fills_raw_2026-06-03.parquet','fills_raw_2026-06-04.parquet'])
WHERE is_liquidation AND direction LIKE '%Long%';
CREATE TEMP TABLE acct AS
WITH pos AS (
  SELECT lower("user") u, market, size, notional/abs(size) AS mark, liquidation_price AS liq,
         CASE WHEN size>0 THEN 1 ELSE -1 END s
  FROM 'perp_2026-06-03.parquet' WHERE abs(size)>0 AND notional>0),
d AS (
  SELECT u, s, CASE WHEN liq IS NULL OR liq<=0 THEN NULL
       WHEN s=1 THEN GREATEST((mark-liq)/mark*100, 0)
       ELSE GREATEST((liq-mark)/mark*100, 0) END / COALESCE(b, ${altMedian}) AS killMove
  FROM pos LEFT JOIN beta ON beta.m = pos.market)
SELECT u, MIN(CASE WHEN s=1 THEN COALESCE(killMove,1e9) ELSE 1e9 END) AS downKill FROM d GROUP BY u;
SELECT (SELECT COUNT(*) FROM victims) AS victims_total, (SELECT COUNT(*) FROM acct) AS accounts_snapshot;
CREATE TEMP TABLE flags AS SELECT a.u, a.downKill, (v.victim IS NOT NULL) AS wiped FROM acct a LEFT JOIN victims v ON v.victim=a.u;
SELECT (downKill<=13.63) AS RED_registered, COUNT(*) n, SUM(CASE WHEN wiped THEN 1 ELSE 0 END) wiped_n, ROUND(100.0*SUM(CASE WHEN wiped THEN 1 ELSE 0 END)/COUNT(*),2) AS pct_wiped FROM flags GROUP BY 1 ORDER BY 1 DESC;
SELECT CASE WHEN downKill<5 THEN '1: <5%' WHEN downKill<10 THEN '2: 5-10%' WHEN downKill<13.63 THEN '3: 10-13.6%' WHEN downKill<1e8 THEN '4: >13.6%' ELSE '5: no down-risk' END AS band,
  COUNT(*) accounts, SUM(CASE WHEN wiped THEN 1 ELSE 0 END) wiped, ROUND(100.0*SUM(CASE WHEN wiped THEN 1 ELSE 0 END)/COUNT(*),2) AS pct_wiped
FROM flags GROUP BY 1 ORDER BY 1;
`;
fs.writeFileSync(new URL('./h2.sql', import.meta.url), sql);
console.log('h2.sql written');
