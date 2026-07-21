// FIELD TEST — a real buyer paying for ALL 22 listed Quiver services with REAL money (Base USDC,
// hand-rolled x402 v2 EIP-3009 payer). Per service: unpaid POST → expect 402 with both rails → sign →
// re-POST with PAYMENT-SIGNATURE → expect 200 → envelope present → independent contentHash recompute
// (sha256 over canonical key-sorted JSON per the envelope's own recipe) → service-specific sanity check.
// Case studies are realistic agent questions, not toy inputs. risk-attest is fed the REAL contentHashes
// collected from earlier paid answers in this same run (the actual agent workflow).
// QA only: self-purchases are never cited as traction.
import { privateKeyToAccount } from 'viem/accounts';
import { randomBytes, createHash } from 'crypto';
import fs from 'fs';

const BASE = 'https://quiver-production-c3a8.up.railway.app';
const raw = fs.readFileSync(new URL('./payer-key.txt', import.meta.url), 'utf8').trim();
const account = privateKeyToAccount(raw.startsWith('0x') ? raw : '0x' + raw);
console.log('Buyer (Base rail):', account.address);

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
  return { env, hashOk: sha256(canonical(pre)) === e.contentHash, signed: !!e.signature };
}

async function payAndCall(path, body) {
  const post = (headers = {}) => fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
  const chall = await post();
  if (chall.status !== 402) return { fail: `expected 402, got ${chall.status}` };
  const cb = await chall.json();
  const nets = (cb.accepts || []).map((a) => a.network);
  const req = (cb.accepts || []).find((a) => a.network === 'eip155:8453');
  if (!req) return { fail: 'no eip155:8453 in accepts' };
  const now = Math.floor(Date.now() / 1000);
  const authorization = { from: account.address, to: req.payTo, value: req.maxAmountRequired, validAfter: '0', validBefore: String(now + 3600), nonce: '0x' + randomBytes(32).toString('hex') };
  const signature = await account.signTypedData({
    domain: { name: req.extra.name, version: req.extra.version, chainId: 8453, verifyingContract: req.asset },
    types: { TransferWithAuthorization: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] },
    primaryType: 'TransferWithAuthorization',
    message: { from: authorization.from, to: authorization.to, value: BigInt(authorization.value), validAfter: 0n, validBefore: BigInt(authorization.validBefore), nonce: authorization.nonce },
  });
  const header = Buffer.from(JSON.stringify({ x402Version: 2, scheme: 'exact', network: 'eip155:8453', payload: { signature, authorization }, accepted: req }), 'utf8').toString('base64');
  const paid = await post({ 'PAYMENT-SIGNATURE': header });
  let settle = null;
  const rec = paid.headers.get('payment-response');
  if (rec) { try { settle = JSON.parse(Buffer.from(rec, 'base64').toString('utf8')); } catch {} }
  const json = await paid.json().catch(() => null);
  return { status: paid.status, priceUsd: Number(req.maxAmountRequired) / 10 ** req.decimals, bothRails: nets.includes('eip155:196') && nets.includes('eip155:8453'), settle, json };
}

// ── realistic case studies (sanity = what a real buyer would check in the answer) ──
const collectedHashes = [];
const CASES = [
  { svc: 'perp-gate', path: '/api/perp-gate', body: { symbol: 'BTC', side: 'long', size: 0.5, margin: 2000, venue: 'hyperliquid' }, sanity: (j) => j.ok === true && j.liquidationPrice > 0 && j.moveToLiquidationPct > 0 },
  { svc: 'size-gate', path: '/api/size-gate', body: { winProb: 0.55, winLossRatio: 1.8, bankroll: 25000, kellyFraction: 0.25 }, sanity: (j) => j.ok === true && j.recommendedSize > 0 },
  { svc: 'portfolio-gate', path: '/api/portfolio-gate', body: { account: '0x7b7f72a28fe109fa703eeed7984f2a8a68fedee2', betaTier: 'severe' }, sanity: (j) => j.ok === true && j.positionsCount >= 1 && j.betaScaledStress?.betaValidation?.PASS === true },
  { svc: 'exec-verify', path: '/api/exec-verify', body: { amountIn: 5000, amountOutRealized: 4885, fairPrice: 0.995, slippageTolerancePct: 1.5 }, sanity: (j) => j.ok === true },
  { svc: 'options-risk', path: '/api/options-risk', body: { forward: 65000, positions: [{ type: 'call', strike: 66000, expiryDays: 30, iv: 0.55, quantity: 2 }, { type: 'put', strike: 62000, expiryDays: 30, iv: 0.6, quantity: -1 }] }, sanity: (j) => j.ok === true && j.portfolioGreeks },
  { svc: 'lp-risk', path: '/api/lp-risk', body: { priceRatio: 1.15, volatility: 0.04, horizonPeriods: 30, feeAprPct: 18, capitalUsd: 25000 }, sanity: (j) => j.ok === true },
  { svc: 'treasury-risk', path: '/api/treasury-risk', body: { positions: [{ asset: 'USDC', amountUsd: 400000, apyPct: 4.1, venue: 'aave', chain: 'ethereum' }, { asset: 'USDT', amountUsd: 350000, apyPct: 5.2, venue: 'binance', chain: 'tron' }, { asset: 'DAI', amountUsd: 150000, apyPct: 3.6, venue: 'spark', chain: 'ethereum' }] }, sanity: (j) => j.ok === true },
  { svc: 'event-vol', path: '/api/event-vol', body: { spot: 65000, atmIvPct: 42, daysToEvent: 9 }, sanity: (j) => j.ok === true && j.expectedMove },
  { svc: 'macro-sentry', path: '/api/macro-sentry', body: { hours: 168, spot: 65000, atmIvPct: 42 }, sanity: (j) => Array.isArray(j.events) || j.nextEvent !== undefined || j.ok !== false },
  { svc: 'options-desk', path: '/api/options-desk', body: { currency: 'BTC' }, sanity: (j) => j.readout && j.compositeVerdict && j.gex },
  { svc: 'updown-pulse', path: '/api/updown-pulse', body: { coin: 'BTC' }, sanity: (j) => j.verdict || j.impliedOdds || j.note },
  { svc: 'tape-pulse', path: '/api/tape-pulse', body: { chain: 'solana', address: '9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump' }, sanity: (j) => j.verdict || j.microstructure || j.kyleLambda !== undefined },
  { svc: 'token-scan', path: '/api/token-scan', body: { chain: 'solana', address: 'DRAMjSWR7HRfJKjRkvQWYL2bcaejaVhuxEcjf4pAY4Cw' }, sanity: (j) => j.verdict !== undefined || j.manipulationRisk !== undefined },
  { svc: 'wallet-audit', path: '/api/wallet-audit', body: { chain: 'solana', address: '9RTez1Ytfqb4EQrnd26oBNdQeWnRiwPkJdwDFpHFwDUj' }, sanity: (j) => j.grade !== undefined || j.verdict !== undefined || j.trackRecord !== undefined },
  { svc: 'loop-digest', path: '/api/loop-digest', body: { chain: 'solana', wallet: '9RTez1Ytfqb4EQrnd26oBNdQeWnRiwPkJdwDFpHFwDUj' }, sanity: (j) => j.cursor !== undefined || j.digest !== undefined || j.changes !== undefined },
  { svc: 'chart-press', path: '/api/chart-press', body: { symbol: 'BTC-USDT', interval: '1H', lookback: 100, quality: 'fast', format: 'svg', indicators: [{ type: 'EMA', period: 20 }, { type: 'RSI' }] }, sanity: (j) => j.imageUrl || j.dataUrl || j.svg || j.card || j.url },
  { svc: 'lp-desk', path: '/api/lp-desk', body: { pool: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640', chain: 'ethereum', days: 1, widthPct: 5, capital: 25000 }, sanity: (j) => j.ok !== false || j.verdict !== undefined },
  { svc: 'protocol-pulse', path: '/api/protocol-pulse', body: { protocol: 'aave' }, sanity: (j) => j.grade !== undefined || j.tvl !== undefined || j.health !== undefined },
  { svc: 'poly-fill', path: '/api/poly-fill', body: { market: 'bitcoin', usd: 250, side: 'YES', action: 'buy' }, sanity: (j) => j.avgPrice !== undefined || j.fill !== undefined || j.executable !== undefined || j.note },
  { svc: 'poly-desk', path: '/api/poly-desk', body: { wallet: '0x16bc7faccdb6dedd07d47333a6f06fef635dd23a' }, sanity: (j) => Array.isArray(j.positions) || j.book !== undefined || j.note },
  { svc: 'calldata-x', path: '/api/calldata-x', body: { to: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', chain: 'ethereum', data: '0xa9059cbb00000000000000000000000065bb932d9987f1d1a98b8942a3fa98cb28ec073b00000000000000000000000000000000000000000000000000000000000f4240' }, sanity: (j) => j.decoded !== undefined || j.summary !== undefined || j.action !== undefined },
  { svc: 'risk-attest', path: '/api/risk-attest', body: null, sanity: (j) => j.merkleRoot !== undefined && j.ok !== false, lazyBody: () => ({ contentHashes: collectedHashes.slice(0, 4) }) },
];

const rows = [];
let spent = 0;
for (const c of CASES) {
  const body = c.lazyBody ? c.lazyBody() : c.body;
  let r;
  try { r = await payAndCall(c.path, body); } catch (e) { r = { fail: e.message.slice(0, 60) }; }
  if (r.fail) { rows.push({ svc: c.svc, ok: false, note: r.fail }); console.log(c.svc.padEnd(15), 'FAIL:', r.fail); continue; }
  const j = r.json || {};
  const envv = verifyEnvelope(j);
  const sane = (() => { try { return !!c.sanity(j); } catch { return false; } })();
  const h = (j.proof || j.observation)?.contentHash;
  if (h) collectedHashes.push(h);
  spent += r.status === 200 ? r.priceUsd : 0;
  const row = { svc: c.svc, http: r.status, priceUsd: r.priceUsd, bothRails: r.bothRails, settled: r.settle?.status === 'settled', tx: r.settle?.transaction?.slice(0, 14), env: envv.env, hashOk: envv.hashOk, signed: envv.signed, sanity: sane };
  rows.push(row);
  console.log(c.svc.padEnd(15), r.status, '| $' + r.priceUsd, '| rails:', r.bothRails ? '2' : '!', '| settled:', row.settled ? 'Y' : 'N', '| env:', envv.env, envv.hashOk ? 'HASH✓' : 'HASH✗', '| sanity:', sane ? 'OK' : '*** CHECK ***');
  await new Promise((res) => setTimeout(res, 800));
}
fs.writeFileSync(new URL('./field-test-results.json', import.meta.url), JSON.stringify({ atUtc: new Date().toISOString(), buyer: account.address, rows, totalSpentUsd: Math.round(spent * 1000) / 1000 }, null, 1));
console.log('\nTOTAL SPENT: $' + spent.toFixed(3), '| services 200:', rows.filter((r) => r.http === 200).length + '/' + rows.length, '| hashOk:', rows.filter((r) => r.hashOk).length, '| sanity OK:', rows.filter((r) => r.sanity).length);
