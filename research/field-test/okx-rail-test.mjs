// OKX-RAIL FIELD TEST — buyer Account 2 (#6166) pays Quiver services over the OKX-native x402 rail:
// X Layer (eip155:196) USD₮0, signed by the OKX agentic wallet's TEE via `onchainos payment pay`
// (no raw private key anywhere). Per service: unpaid POST → 402 → PAYMENT-REQUIRED (v2, base64) →
// CLI signs the eip155:196 entry → replay with the returned header → 200 → decode PAYMENT-RESPONSE
// settlement → independent envelope contentHash recompute. Guards: the selected accepts entry MUST match
// the expected payTo and price ceiling or the run aborts. QA only — never counted as traction.
import { execSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';

const BASE = 'https://quiver-production-c3a8.up.railway.app';
const EXPECTED_PAYTO = '0x65bb932d9987f1d1a98b8942a3fa98cb28ec073b';
const MAX_PRICE = 0.02; // batch-1 ceiling per call (USD₮0)

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

const collectedHashes = [];
const CASES = [
  { svc: 'perp-gate', path: '/api/perp-gate', body: { symbol: 'BTC', side: 'long', size: 0.5, margin: 2000, venue: 'hyperliquid' } },
  { svc: 'size-gate', path: '/api/size-gate', body: { winProb: 0.55, winLossRatio: 1.8, bankroll: 25000, kellyFraction: 0.25 } },
  { svc: 'exec-verify', path: '/api/exec-verify', body: { amountIn: 5000, amountOutRealized: 4885, fairPrice: 0.995, slippageTolerancePct: 1.5 } },
  { svc: 'lp-risk', path: '/api/lp-risk', body: { priceRatio: 1.15, volatility: 0.04, horizonPeriods: 30, feeAprPct: 18, capitalUsd: 25000 } },
  { svc: 'event-vol', path: '/api/event-vol', body: { spot: 65000, atmIvPct: 42, daysToEvent: 9 } },
  { svc: 'macro-sentry', path: '/api/macro-sentry', body: { hours: 168, spot: 65000, atmIvPct: 42 } },
  { svc: 'options-desk', path: '/api/options-desk', body: { currency: 'BTC' } },
  { svc: 'updown-pulse', path: '/api/updown-pulse', body: { coin: 'BTC' } },
  { svc: 'tape-pulse', path: '/api/tape-pulse', body: { chain: 'solana', address: '9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump' } },
  { svc: 'loop-digest', path: '/api/loop-digest', body: { chain: 'solana', wallet: '9RTez1Ytfqb4EQrnd26oBNdQeWnRiwPkJdwDFpHFwDUj' } },
  { svc: 'lp-desk', path: '/api/lp-desk', body: { pool: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640', chain: 'ethereum', days: 1, widthPct: 5, capital: 25000 } },
  { svc: 'protocol-pulse', path: '/api/protocol-pulse', body: { protocol: 'aave' } },
  { svc: 'poly-fill', path: '/api/poly-fill', body: { market: 'bitcoin', usd: 250, side: 'YES', action: 'buy' } },
  { svc: 'calldata-x', path: '/api/calldata-x', body: { to: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', chain: 'ethereum', data: '0xa9059cbb00000000000000000000000065bb932d9987f1d1a98b8942a3fa98cb28ec073b00000000000000000000000000000000000000000000000000000000000f4240' } },
  { svc: 'risk-attest', path: '/api/risk-attest', lazyBody: () => ({ contentHashes: collectedHashes.slice(0, 4) }) },
];

const rows = [];
let spent = 0;
for (const c of CASES) {
  const body = c.lazyBody ? c.lazyBody() : c.body;
  try {
    const chall = await fetch(BASE + c.path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
    if (chall.status !== 402) { rows.push({ svc: c.svc, ok: false, note: `expected 402 got ${chall.status}` }); continue; }
    const raw = chall.headers.get('payment-required');
    if (!raw) { rows.push({ svc: c.svc, ok: false, note: 'no PAYMENT-REQUIRED header' }); continue; }
    const decoded = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    const idx = (decoded.accepts || []).findIndex((a) => a.network === 'eip155:196');
    const acc = decoded.accepts?.[idx];
    const price = acc ? Number(acc.maxAmountRequired || acc.amount) / 10 ** (acc.decimals ?? 6) : null;
    if (idx < 0 || String(acc.payTo).toLowerCase() !== EXPECTED_PAYTO || !(price > 0) || price > MAX_PRICE) {
      rows.push({ svc: c.svc, ok: false, note: `guard abort: idx=${idx} payTo=${acc?.payTo} price=${price}` });
      console.log(c.svc.padEnd(15), 'GUARD ABORT'); continue;
    }
    const out = execSync(`onchainos payment pay --payload "${raw}" --selected-index ${idx}`, { encoding: 'utf8', timeout: 120000 });
    const pay = JSON.parse(out.trim().split('\n').pop());
    if (!pay.ok || !pay.data?.authorization_header) { rows.push({ svc: c.svc, ok: false, note: 'pay failed: ' + JSON.stringify(pay).slice(0, 120) }); console.log(c.svc.padEnd(15), 'PAY FAIL'); continue; }
    const hn = pay.data.header_name || 'PAYMENT-SIGNATURE';
    const paid = await fetch(BASE + c.path, { method: 'POST', headers: { 'content-type': 'application/json', [hn]: pay.data.authorization_header }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
    let settle = null;
    const rec = paid.headers.get('payment-response');
    if (rec) { try { settle = JSON.parse(Buffer.from(rec, 'base64').toString('utf8')); } catch {} }
    const j = await paid.json().catch(() => null);
    const envv = j ? verifyEnvelope(j) : { env: null, hashOk: null };
    const h = (j?.proof || j?.observation)?.contentHash;
    if (h) collectedHashes.push(h);
    if (paid.status === 200) spent += price;
    const row = { svc: c.svc, http: paid.status, priceUsd: price, settled: settle?.status === 'settled' || settle?.success === true, network: settle?.network, tx: settle?.transaction, env: envv.env, hashOk: envv.hashOk, scheme: pay.data.scheme, wallet: pay.data.wallet };
    rows.push(row);
    console.log(c.svc.padEnd(15), paid.status, '| $' + price, '| settled:', row.settled ? 'Y' : '?', '| net:', settle?.network || '-', '| env:', envv.env, envv.hashOk ? 'HASH✓' : 'HASH✗');
  } catch (e) {
    rows.push({ svc: c.svc, ok: false, note: String(e.message || e).slice(0, 140) });
    console.log(c.svc.padEnd(15), 'ERR:', String(e.message || e).slice(0, 100));
  }
  await new Promise((r) => setTimeout(r, 1200));
}
fs.writeFileSync(new URL('./okx-rail-results.json', import.meta.url), JSON.stringify({ atUtc: new Date().toISOString(), buyer: '0x1b010a9cf4c6302a0ffcfec08e2fbf23e3e1f0d4 (Account 2 / #6166)', rail: 'eip155:196 USD₮0 via OKX facilitator, TEE-signed', rows, totalSpentUsd: Math.round(spent * 1000) / 1000 }, null, 1));
console.log('\nTOTAL:', '$' + spent.toFixed(3), '| 200s:', rows.filter((r) => r.http === 200).length + '/' + rows.length, '| settled:', rows.filter((r) => r.settled).length, '| hashOk:', rows.filter((r) => r.hashOk).length);
