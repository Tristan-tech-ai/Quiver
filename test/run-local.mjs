// Local smoke test (DEV_MODE): known-wash token, known-organic token, hollow wallet.
const BASE = process.env.BASE || 'http://localhost:8402';

async function call(path, body) {
  const t0 = Date.now();
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  console.log(`\n=== ${path} ${JSON.stringify(body)} -> ${res.status} in ${Date.now() - t0}ms ===`);
  console.log(JSON.stringify(json, null, 2).slice(0, 2600));
  return json;
}

// 1) DRAM — the $4.7B-volume / 73-trader token (expected: MANUFACTURED, high wash share)
await call('/api/token-scan', { chain: 'solana', address: 'DRAMjSWR7HRfJKjRkvQWYL2bcaejaVhuxEcjf4pAY4Cw' });

// 2) ANSEM — 128k holders / 23k unique traders (expected: ORGANIC-ish, low wash share)
await call('/api/token-scan', { chain: 'solana', address: '9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump' });

// 3) The 100%-win-rate breakeven churner from the leaderboard (expected: hollow / low grade)
await call('/api/wallet-audit', { chain: 'solana', address: '9RTez1Ytfqb4EQrnd26oBNdQeWnRiwPkJdwDFpHFwDUj' });
