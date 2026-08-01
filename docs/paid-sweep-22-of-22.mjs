// FULL PAID SWEEP of all 22 live services, on the X Layer rail, through the official OKX Payment SDK.
// SPENDS REAL MONEY (0.360000 USD₮0 if every call is delivered). Not part of any automated suite.
//
//   node hackathon/field-test/sweep22-sdk.mjs
//
// WHY IT EXISTS. On 1 August 2026 the paid rail was dead for at least seventeen hours while every check
// the repository owns stayed green: OKX's x402-check passed 22/22, validate-listing was clean, preflight
// was 37/37, and every endpoint answered a well-formed 402. What none of them could see was that
// settlement never landed. So the only instrument that answers "can a buyer actually get an answer" is
// a buyer, paying, and then the chain.
//
// WHAT IT REFUSES TO DO:
//   · It does not trust the PAYMENT-RESPONSE receipt. Every transaction hash it reports is re-fetched
//     from an RPC and its Transfer log decoded, because a receipt is our own server's claim.
//   · It does not read the wallet's balance API for the reconciliation. That endpoint has served stale
//     mid-settlement values before. Balances come from eth_call against the token.
//   · It does not switch accounts for you. Paying from the owner wallet would be paying ourselves and
//     would measure nothing, so it asserts the active account and stops if it is wrong.
//
// Bodies come from gates/routing-fixtures.mjs GENUINE, the same fixtures preflight validates against
// each service's own validate(), so a failure here is the service's and not a hand-typed body's.
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const VT = 'C:/Users/Tristan/Downloads/research startup/hackathon/veritape';
const { SERVICES } = await import(pathToFileURL(`${VT}/src/services.js`).href);
const { GENUINE } = await import(pathToFileURL(`${VT}/gates/routing-fixtures.mjs`).href);

const BASE = 'https://quiver-production-c3a8.up.railway.app';
const BUYER = '0x1b010a9cf4c6302a0ffcfec08e2fbf23e3e1f0d4';   // Account 2, agent #6166
const PAYTO = '0x65bb932d9987f1d1a98b8942a3fa98cb28ec073b';   // Account 1, the listing owner
const RPC = 'https://xlayer.drpc.org';
const TOKEN = '0x779Ded0c9e1022225f8E0630b35a9b54bE713736';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const NETWORK = 'eip155:196';

// The service rate-limits at 60/min/IP. Pace under that rather than retrying into it.
const MIN_GAP_MS = 1200;
let lastAt = 0;
const paced = async (url, init) => {
  const wait = MIN_GAP_MS - (Date.now() - lastAt);
  if (wait > 0) await new Promise((s) => setTimeout(s, wait));
  lastAt = Date.now();
  return fetch(url, init);
};

// Several endpoints, tried in turn with backoff. A public RPC's rate limit is not a finding about the
// service under test, and letting one throw would abandon a sweep that has already spent real money.
const RPCS = [RPC, 'https://rpc.xlayer.tech', 'https://xlayerrpc.okx.com'];
const rpc = async (method, params, tries = 4) => {
  let last;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    for (const url of RPCS) {
      try {
        const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
        const j = await r.json();
        if (!j.error) return j.result;
        last = new Error(`${url}: ${j.error.message}`);
      } catch (e) { last = e; }
    }
    await new Promise((s) => setTimeout(s, 1500 * (attempt + 1)));
  }
  throw last;
};
const balOf = async (a) => Number(BigInt(await rpc('eth_call', [{ to: TOKEN, data: '0x70a08231' + a.slice(2).padStart(64, '0') }, 'latest']))) / 1e6;

// ---- guard: the buyer must be the active account, or this measures nothing ----
const status = JSON.parse(execFileSync('onchainos', ['wallet', 'addresses'], { encoding: 'utf8' }));
const active = (status.data.evm.find((e) => e.chainName === 'eth') || status.data.evm[0]).address.toLowerCase();
if (active !== BUYER.toLowerCase()) {
  console.log(`  STOP: active account is ${active}, expected the buyer ${BUYER}`);
  console.log('  run: onchainos wallet switch 5576bf78-7820-4e0a-bd34-877bed6f1a2c');
  process.exit(2);
}

const before = { buyer: await balOf(BUYER), payTo: await balOf(PAYTO) };
const startBlock = BigInt(await rpc('eth_blockNumber', []));
console.log(`  buyer  ${BUYER}  ${before.buyer.toFixed(6)} USD₮0`);
console.log(`  payTo  ${PAYTO}  ${before.payTo.toFixed(6)} USD₮0`);
console.log(`  start block ${startBlock}\n`);

// `--only slug,slug` re-runs a subset. Useful when a previous pass already settled most of the
// catalogue and only the failures need re-testing, so the retest does not re-spend on what worked.
const onlyArg = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1]
  || (process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null);
const ONLY = onlyArg ? new Set(onlyArg.split(',').map((x) => x.trim())) : null;
const TARGETS = ONLY ? SERVICES.filter((s) => ONLY.has(s.path.replace(/^\/api\//, ''))) : SERVICES;
if (ONLY && TARGETS.length !== ONLY.size) {
  console.log(`  STOP: --only named ${ONLY.size} slugs but matched ${TARGETS.length}. A typo would silently shrink the test.`);
  process.exit(2);
}
const budget = TARGETS.reduce((a, s) => a + Number(s.price), 0);
console.log(`  testing ${TARGETS.length} service(s), costing ${budget.toFixed(6)} USD₮0${ONLY ? ' (subset)' : ''}`);
if (budget > before.buyer) { console.log(`  STOP: buyer holds ${before.buyer.toFixed(6)}, needs ${budget.toFixed(6)}`); process.exit(2); }
console.log('');

const rows = [];
for (const s of TARGETS) {
  const slug = s.path.replace(/^\/api\//, '');
  const fixtures = GENUINE[slug];
  const body = Array.isArray(fixtures) ? fixtures[0] : fixtures;
  const row = { service: s.name, slug, price: s.price, status: null, tx: null, proof: null, note: '' };
  try {
    // 1. challenge
    const chal = await paced(`${BASE}${s.path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const header = chal.headers.get('payment-required');
    if (chal.status !== 402 || !header) { row.note = `challenge was ${chal.status}`; rows.push(row); console.log(`  ${'FAIL'.padEnd(6)}${slug}  ${row.note}`); continue; }
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    const idx = decoded.accepts.findIndex((a) => a.network === NETWORK);
    if (idx < 0) { row.note = 'no X Layer rail in accepts'; rows.push(row); console.log(`  ${'FAIL'.padEnd(6)}${slug}  ${row.note}`); continue; }

    // 2. sign from the buyer wallet (TEE — no raw key anywhere)
    const signed = JSON.parse(execFileSync('onchainos', ['payment', 'pay', '--payload', header, '--selected-index', String(idx)], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
    if (!signed.ok) { row.note = `signing failed: ${JSON.stringify(signed).slice(0, 120)}`; rows.push(row); console.log(`  ${'FAIL'.padEnd(6)}${slug}  ${row.note}`); continue; }

    // 3. replay
    const paid = await paced(`${BASE}${s.path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [signed.data.header_name || 'PAYMENT-SIGNATURE']: signed.data.authorization_header },
      body: JSON.stringify(body),
    });
    row.status = paid.status;
    const receipt = paid.headers.get('payment-response');
    if (receipt) {
      const r = JSON.parse(Buffer.from(receipt, 'base64').toString('utf8'));
      row.tx = r.transaction || r.txHash || null;
      if (!row.tx) row.note = `receipt success=${r.success} status=${r.status} but NO transaction`;
    }
    const text = await paid.text();
    try { const j = JSON.parse(text); row.proof = j.proof ? 'proof' : j.observation ? 'observation' : null; }
    catch { row.note ||= 'response was not JSON'; }
    if (paid.status !== 200) row.note ||= `HTTP ${paid.status}: ${text.slice(0, 110)}`;
  } catch (e) {
    row.note = String(e.message || e).slice(0, 140);
  }
  rows.push(row);
  const mark = row.status === 200 && row.tx ? 'OK' : row.status === 200 ? 'NOTX' : 'FAIL';
  console.log(`  ${mark.padEnd(6)}${slug.padEnd(16)}${String(row.price).padStart(6)}  ${row.status ?? '-'}  ${row.tx ? row.tx.slice(0, 14) + '…' : '-'}  ${row.proof || ''} ${row.note}`);
}

// ---- reconcile against the CHAIN, not the receipts ----
await new Promise((s) => setTimeout(s, 10000));
const after = { buyer: await balOf(BUYER), payTo: await balOf(PAYTO) };
const endBlock = BigInt(await rpc('eth_blockNumber', []));

const claimed = rows.filter((r) => r.status === 200 && r.tx).reduce((a, r) => a + Number(r.price), 0);
const movedIn = after.payTo - before.payTo;
const movedOut = before.buyer - after.buyer;

// Independent census of what actually arrived, so the reconciliation does not depend on any receipt.
// 100, not 10,000: rpc.xlayer.tech and the OKX endpoint both cap getLogs at 100 blocks even with a
// topic filter, and this has to work on whichever endpoint is not rate-limited at the time. The sweep
// spans a couple of minutes, so a hundred-block window is a handful of calls, not thousands.
const CHUNK = 100n;
const logs = [];
for (let b = startBlock; b <= endBlock; b += CHUNK) {
  const end = b + CHUNK - 1n > endBlock ? endBlock : b + CHUNK - 1n;
  logs.push(...await rpc('eth_getLogs', [{
    address: TOKEN, fromBlock: '0x' + b.toString(16), toBlock: '0x' + end.toString(16),
    topics: [TRANSFER, '0x' + BUYER.slice(2).padStart(64, '0'), '0x' + PAYTO.slice(2).padStart(64, '0')],
  }]));
}
const censusTotal = logs.reduce((a, l) => a + Number(BigInt(l.data)) / 1e6, 0);
const censusHashes = new Set(logs.map((l) => l.transactionHash.toLowerCase()));
const receiptHashes = rows.filter((r) => r.tx).map((r) => r.tx.toLowerCase());
const unmatched = receiptHashes.filter((h) => !censusHashes.has(h));

const delivered = rows.filter((r) => r.status === 200).length;
const withTx = rows.filter((r) => r.tx).length;
// Count proofs only on DELIVERED answers. The first version counted any row whose body carried a
// `proof` key, and a refusal body can carry one too, so it reported eight where seven were served. A
// counter that inflates on failure is the same class of instrument defect this file exists to catch.
const proofs = rows.filter((r) => r.status === 200 && r.proof === 'proof').length;

console.log(`\n  ================ RESULT ================`);
console.log(`  delivered (HTTP 200)          ${delivered} / ${rows.length}`);
console.log(`  settled with a tx hash        ${withTx} / ${rows.length}`);
console.log(`  answers carrying a zk proof   ${proofs}`);
console.log(`  claimed by receipts           ${claimed.toFixed(6)} USD₮0`);
console.log(`  buyer balance fell by         ${movedOut.toFixed(6)}`);
console.log(`  payTo balance rose by         ${movedIn.toFixed(6)}`);
console.log(`  on-chain census buyer->payTo  ${censusTotal.toFixed(6)} across ${logs.length} transfers (blocks ${startBlock}..${endBlock})`);
console.log(`  receipt hashes NOT on chain   ${unmatched.length}${unmatched.length ? ' -> ' + unmatched.join(', ') : ''}`);
const exact = Math.abs(censusTotal - claimed) < 1e-9 && Math.abs(movedIn - claimed) < 1e-9 && unmatched.length === 0;
console.log(`\n  ==> ${exact ? 'RECONCILES EXACTLY: every receipt is on chain and the amounts agree to the last decimal'
  : 'DOES NOT RECONCILE — read the rows above before believing any of them'}`);

mkdirSync('C:/Users/Tristan/Downloads/research startup/hackathon/field-test', { recursive: true });
writeFileSync('C:/Users/Tristan/Downloads/research startup/hackathon/field-test/sweep22-sdk-result.json',
  JSON.stringify({ base: BASE, buyer: BUYER, payTo: PAYTO, before, after, startBlock: String(startBlock), endBlock: String(endBlock), claimed, movedIn, movedOut, censusTotal, censusTransfers: logs.length, unmatched, rows }, null, 2));
console.log(`  written: hackathon/field-test/sweep22-sdk-result.json`);
process.exit(exact ? 0 : 1);
