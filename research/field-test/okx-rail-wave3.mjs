// OKX-rail field test â€” WAVE 2: the five higher-priced services, buyer Account 2 (#6166), TEE-signed.
// Same protocol + guards as okx-rail-test.mjs; MAX_PRICE raised to 0.05 for this wave.
import { execSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';

const BASE = 'https://quiver-production-c3a8.up.railway.app';
const EXPECTED_PAYTO = '0x65bb932d9987f1d1a98b8942a3fa98cb28ec073b';
const MAX_PRICE = 0.05;

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const canonical = (o) => {
  if (o === null || typeof o !== 'object') return JSON.stringify(o) ?? 'null';
  if (Array.isArray(o)) return '[' + o.map(canonical).join(',') + ']';
  return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + canonical(o[k])).join(',') + '}';
};
function verifyEnvelope(resp) {
  const env = resp.proof ? 'proof' : resp.observation ? 'observation' : null;
  if (!env) return { env: null, hashOk: null };
  const e = resp[env];
  const { [env]: _, ...result } = resp;
  const pre = env === 'proof'
    ? { engine: e.engine, codeHash: e.codeHash, inputs: e.inputs, result }
    : { engine: e.engine, codeHash: e.codeHash, observedAtUtc: e.observedAtUtc, inputs: e.inputs, result };
  return { env, hashOk: sha256(canonical(pre)) === e.contentHash };
}

const CASES_W3 = [
  { svc: 'chart-press', path: '/api/chart-press', body: { symbol: 'BTC-USDT', interval: '1H', lookback: 100, quality: 'fast', format: 'svg', indicators: [{ type: 'EMA', period: 20 }, { type: 'RSI' }] } },
  { svc: 'poly-desk', path: '/api/poly-desk', body: { wallet: '0x16bc7faccdb6dedd07d47333a6f06fef635dd23a' } },
];
const CASES_UNUSED = [
  { svc: 'portfolio-gate', path: '/api/portfolio-gate', body: { account: '0x7b7f72a28fe109fa703eeed7984f2a8a68fedee2', betaTier: 'severe' } },
  { svc: 'token-scan', path: '/api/token-scan', body: { chain: 'solana', address: 'DRAMjSWR7HRfJKjRkvQWYL2bcaejaVhuxEcjf4pAY4Cw' } },
  { svc: 'wallet-audit', path: '/api/wallet-audit', body: { chain: 'solana', address: '9RTez1Ytfqb4EQrnd26oBNdQeWnRiwPkJdwDFpHFwDUj' } },
  { svc: 'options-risk', path: '/api/options-risk', body: { forward: 65000, positions: [{ type: 'call', strike: 66000, expiryDays: 30, iv: 0.55, quantity: 2 }, { type: 'put', strike: 62000, expiryDays: 30, iv: 0.6, quantity: -1 }] } },
  { svc: 'treasury-risk', path: '/api/treasury-risk', body: { positions: [{ asset: 'USDC', amountUsd: 400000, apyPct: 4.1, venue: 'aave', chain: 'ethereum' }, { asset: 'USDT', amountUsd: 350000, apyPct: 5.2, venue: 'binance', chain: 'tron' }, { asset: 'DAI', amountUsd: 150000, apyPct: 3.6, venue: 'spark', chain: 'ethereum' }] } },
];

const rows = [];
let spent = 0;
for (const c of CASES_W3) {
  try {
    const chall = await fetch(BASE + c.path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(c.body), signal: AbortSignal.timeout(60000) });
    if (chall.status !== 402) { rows.push({ svc: c.svc, ok: false, note: `expected 402 got ${chall.status}` }); continue; }
    const raw = chall.headers.get('payment-required');
    const decoded = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    const idx = (decoded.accepts || []).findIndex((a) => a.network === 'eip155:196');
    const acc = decoded.accepts?.[idx];
    const price = acc ? Number(acc.maxAmountRequired || acc.amount) / 10 ** (acc.decimals ?? 6) : null;
    if (idx < 0 || String(acc.payTo).toLowerCase() !== EXPECTED_PAYTO || !(price > 0) || price > MAX_PRICE) {
      rows.push({ svc: c.svc, ok: false, note: `guard abort: payTo=${acc?.payTo} price=${price}` });
      console.log(c.svc.padEnd(15), 'GUARD ABORT'); continue;
    }
    const out = execSync(`onchainos payment pay --payload "${raw}" --selected-index ${idx}`, { encoding: 'utf8', timeout: 120000 });
    const pay = JSON.parse(out.trim().split('\n').pop());
    if (!pay.ok || !pay.data?.authorization_header) { rows.push({ svc: c.svc, ok: false, note: 'pay failed' }); console.log(c.svc.padEnd(15), 'PAY FAIL'); continue; }
    const hn = pay.data.header_name || 'PAYMENT-SIGNATURE';
    const paid = await fetch(BASE + c.path, { method: 'POST', headers: { 'content-type': 'application/json', [hn]: pay.data.authorization_header }, body: JSON.stringify(c.body), signal: AbortSignal.timeout(180000) });
    let settle = null;
    const rec = paid.headers.get('payment-response');
    if (rec) { try { settle = JSON.parse(Buffer.from(rec, 'base64').toString('utf8')); } catch {} }
    const j = await paid.json().catch(() => null);
    const envv = j ? verifyEnvelope(j) : { env: null, hashOk: null };
    if (paid.status === 200) spent += price;
    const row = { svc: c.svc, http: paid.status, priceUsd: price, settled: settle?.status === 'settled' || settle?.success === true, network: settle?.network, tx: settle?.transaction, env: envv.env, hashOk: envv.hashOk };
    rows.push(row);
    console.log(c.svc.padEnd(15), paid.status, '| $' + price, '| settled:', row.settled ? 'Y' : '?', '| net:', settle?.network || '-', '| env:', envv.env, envv.hashOk ? 'HASHâœ“' : 'HASHâœ—');
  } catch (e) {
    rows.push({ svc: c.svc, ok: false, note: String(e.message || e).slice(0, 140) });
    console.log(c.svc.padEnd(15), 'ERR:', String(e.message || e).slice(0, 100));
  }
  await new Promise((r) => setTimeout(r, 1500));
}
fs.writeFileSync(new URL('./okx-rail-wave3-results.json', import.meta.url), JSON.stringify({ atUtc: new Date().toISOString(), rows, totalSpentUsd: Math.round(spent * 1000) / 1000 }, null, 1));
console.log('\nWAVE 3 TOTAL:', '$' + spent.toFixed(3), '| 200s:', rows.filter((r) => r.http === 200).length + '/' + rows.length, '| hashOk:', rows.filter((r) => r.hashOk).length);

