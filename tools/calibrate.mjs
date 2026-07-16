// Scan a labelled set through the live /diag/scan endpoint and print a comparison table.
import fs from 'node:fs';
const BASE = 'https://quiver-production-c3a8.up.railway.app/diag/scan';
const TOKEN = fs.readFileSync(new URL('../.diag-token', import.meta.url), 'utf8').trim();

const TOKENS = [
  ['WASH?  MONA',      'solana', '5aPNdSPZkzHtanNmA7jaouJtr8aqsdzAZXP13MLcqFsg'],
  ['WASH?  blackfebu', 'solana', '5HkrLN1bYy7FBW5Z3NUT87C2hHVVkZQ1biEdfJea9Jxv'],
  ['WASH?  W26',       'solana', 'AKD97wZUcoXUiWnb5hRC4ArZ1yNmtC6C6f7FGC3jjAoU'],
  ['ORG?   agentx402', 'solana', 'AKRFDXvAvErveXfzXjtyok1E5fFzkkRHipJAU1dwpgZ9'],
  ['ORG?   cooked',    'solana', '7ArzToHGp7YcdsLQ6hkr1YBk6KasVLZmAk5gv1C5bdZE'],
  ['ORG?   HOOD',      'solana', '5QesigRX75CrCDZ3rZbayJo7KfciqsLwqZ4YisZhPFvZ'],
  ['ETF    DRAM',      'solana', 'DRAMjSWR7HRfJKjRkvQWYL2bcaejaVhuxEcjf4pAY4Cw'],
];
const WALLET = ['9RTez1Ytfqb4EQrnd26oBNdQeWnRiwPkJdwDFpHFwDUj'];

async function scan(kind, chain, address) {
  const u = `${BASE}?token=${TOKEN}&kind=${kind}&chain=${chain}&address=${address}`;
  const r = await fetch(u, { signal: AbortSignal.timeout(45000) });
  return r.json();
}

console.log('TOKEN SCANS');
for (const [label, chain, addr] of TOKENS) {
  try {
    const j = await scan('token', chain, addr);
    const s = Object.fromEntries((j.signals || []).map((c) => [c.key, c.value]));
    console.log(`${label.padEnd(18)} ${String(j.verdict).padEnd(15)} risk=${String(j.riskScore).padEnd(4)} conf=${String(j.confidence).padEnd(5)} vel=${s.tradeVelocityPerMin ?? '-'} vol/liq=${s.volumeToLiquidity ?? '-'} rtShare=${s.tapeRoundTripShare ?? '-'} wash=${j.estimatedWashVolumeShare ?? '-'} ${j.elapsedMs ?? '?'}ms`);
  } catch (e) { console.log(`${label.padEnd(18)} ERR ${e.message}`); }
}
console.log('\nWALLET AUDITS');
for (const w of WALLET) {
  try {
    const j = await scan('wallet', 'solana', w);
    console.log(`${w.slice(0, 8)} grade=${j.grade} score=${j.authenticityScore} verdict=${j.verdict} conf=${j.confidence} winCI=${JSON.stringify(j.headline?.winRate95ci)}`);
  } catch (e) { console.log(`${w} ERR ${e.message}`); }
}
