// Recount of the buyer desk's settlement ledger, published so the figures in Section 6.4 of the
// technical documentation can be checked rather than believed.
//
//   node research/buyer-ledger-recount.mjs
//
// The buyer ("Sentinel", wallet 0xba3ae4e9…1f9b on X Layer) published its own report on 25 July 2026
// covering 21–25 July; its desk then kept running until its spending envelope ran out at 02:00 UTC on
// 26 July. This script reads the buyer's raw ledger and recomputes the table for the whole record.
//
// It is not asking to be trusted either. Run against the three days the buyer did publish, it must
// return 18, 43 and 27 settled-without-a-transaction rows for 21, 22 and 23 July — the same three
// numbers as Table 7 of the documentation, which the buyer stood behind. If those three do not
// reproduce, treat every other number this script prints as unproven.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const lines = readFileSync(join(here, 'BUYER_LEDGER.csv'), 'utf8').trim().split(/\r?\n/);
const cols = lines[0].split(',');
const iTs = cols.indexOf('ts_utc'), iStatus = cols.indexOf('status'), iTx = cols.indexOf('tx'), iPrice = cols.indexOf('price_usd');

const days = new Map();
for (const line of lines.slice(1)) {
  const c = line.split(',');
  const day = (c[iTs] || '').slice(0, 10);
  if (!day) continue;
  const d = days.get(day) || { rows: 0, settled: 0, notCharged: 0, noTx: 0, usd: 0 };
  d.rows += 1;
  if (c[iStatus] === 'settled') {
    d.settled += 1;
    d.usd += Number(c[iPrice]) || 0;
    // A settlement is only a settlement if it names an on-chain transaction. The defect this table
    // measures was accepting the facilitator's success flag instead, so the test is the tx column
    // itself and nothing else in the row.
    if (!/^0x[0-9a-fA-F]{64}$/.test((c[iTx] || '').trim())) d.noTx += 1;
  } else if (c[iStatus] === 'not_charged') d.notCharged += 1;
  days.set(day, d);
}

console.log('day          rows  settled  not_charged  settled without a tx hash      USD');
let tRows = 0, tSettled = 0, tNoTx = 0, tUsd = 0;
for (const [day, d] of [...days].sort()) {
  const pct = d.settled ? ((d.noTx / d.settled) * 100).toFixed(2) : '0.00';
  console.log(`${day}  ${String(d.rows).padStart(5)}  ${String(d.settled).padStart(7)}  ${String(d.notCharged).padStart(11)}  ${String(d.noTx).padStart(12)} (${pct.padStart(5)}%)  ${d.usd.toFixed(3).padStart(7)}`);
  tRows += d.rows; tSettled += d.settled; tNoTx += d.noTx; tUsd += d.usd;
}
console.log(`TOTAL        ${String(tRows).padStart(5)}  ${String(tSettled).padStart(7)}  ${''.padStart(11)}  ${String(tNoTx).padStart(12)}          ${tUsd.toFixed(3).padStart(7)}`);

// The anchor. These three are the buyer's own published figures; if they do not reproduce, the rest
// of this output is not evidence of anything.
const anchor = [['2026-07-21', 18], ['2026-07-22', 43], ['2026-07-23', 27]];
const bad = anchor.filter(([d, n]) => (days.get(d)?.noTx ?? -1) !== n);
console.log('');
if (bad.length) {
  console.log(`ANCHOR FAILED — ${bad.map(([d, n]) => `${d} expected ${n}, got ${days.get(d)?.noTx}`).join('; ')}`);
  console.log('The buyer\'s published pre-fix figures do not reproduce from this ledger. Treat the rest as unproven.');
  process.exit(1);
}
const postFix = ['2026-07-25', '2026-07-26'].reduce((s, d) => s + (days.get(d)?.settled ?? 0), 0);
const postFixNoTx = ['2026-07-25', '2026-07-26'].reduce((s, d) => s + (days.get(d)?.noTx ?? 0), 0);
console.log('ANCHOR OK — the buyer\'s published 18 / 43 / 27 reproduce from this file.');
console.log(`POST-FIX  — ${postFix} settled calls after the acceptance fix, ${postFixNoTx} of them without a transaction hash.`);
