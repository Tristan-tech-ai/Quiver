// Fire a battery of candidate OKX v6 API paths through the deployed /diag/rest prober
// and report which return real data. Run once keys are live: node tools/discover-paths.mjs
import fs from 'node:fs';

const BASE = 'https://quiver-production-c3a8.up.railway.app/diag/rest';
const TOKEN = (fs.readFileSync(new URL('../.diag-token', import.meta.url), 'utf8')).trim();
const SOL = '501';
const TOK = 'DRAMjSWR7HRfJKjRkvQWYL2bcaejaVhuxEcjf4pAY4Cw';
const WALLET = '9RTez1Ytfqb4EQrnd26oBNdQeWnRiwPkJdwDFpHFwDUj';

const q = (o) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join('&');
const tokenQ = q({ chainIndex: SOL, tokenContractAddress: TOK });
const walletQ = q({ chainIndex: SOL, walletAddress: WALLET, address: WALLET });

// resource -> candidate paths (v6 dex market family)
const CANDIDATES = {
  trades: [`/api/v6/dex/market/trades?${tokenQ}&limit=3`],
  priceInfo: [
    `/api/v6/dex/market/price-info?${tokenQ}`,
    `/api/v6/dex/market/token/price-info?${tokenQ}`,
    `/api/v6/dex/index/price-info?${tokenQ}`,
  ],
  advancedInfo: [
    `/api/v6/dex/market/token/advanced-info?${tokenQ}`,
    `/api/v6/dex/market/advanced-info?${tokenQ}`,
    `/api/v6/dex/market/token-detail?${tokenQ}`,
  ],
  holders: [
    `/api/v6/dex/market/holders?${tokenQ}`,
    `/api/v6/dex/market/token/holders?${tokenQ}`,
  ],
  clusterOverview: [
    `/api/v6/dex/market/holders/cluster-overview?${tokenQ}`,
    `/api/v6/dex/market/cluster-overview?${tokenQ}`,
    `/api/v6/dex/market/holder-cluster/overview?${tokenQ}`,
  ],
  portfolioOverview: [
    `/api/v6/dex/market/portfolio/overview?${walletQ}&timeFrame=4`,
    `/api/v6/dex/market/portfolio-overview?${walletQ}&timeFrame=4`,
    `/api/v6/dex/balance/portfolio-overview?${walletQ}`,
    `/api/v6/dex/market/wallet/portfolio-overview?${walletQ}`,
  ],
  recentPnl: [
    `/api/v6/dex/market/portfolio/recent-pnl?${walletQ}`,
    `/api/v6/dex/market/portfolio-recent-pnl?${walletQ}`,
  ],
};

async function probe(path) {
  const u = `${BASE}?token=${TOKEN}&path=${encodeURIComponent(path)}`;
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(30000) });
    const j = await r.json();
    const body = j.body || JSON.stringify(j).slice(0, 200);
    const hasData = /"data":\s*\[?\s*[\[{]/.test(body) || /"code":"0"/.test(body);
    return { status: j.status, keyed: j.keyed, hasData, snippet: (body || '').slice(0, 160) };
  } catch (e) {
    return { status: 'ERR', err: String(e.message).slice(0, 60) };
  }
}

for (const [resource, paths] of Object.entries(CANDIDATES)) {
  console.log(`\n### ${resource}`);
  for (const p of paths) {
    const r = await probe(p);
    const mark = r.hasData ? 'DATA ✓' : `${r.status}`;
    console.log(`  [${mark}] ${p.split('?')[0]}  ${r.hasData ? '' : (r.snippet || r.err || '')}`.slice(0, 160));
    if (r.hasData) break; // first working candidate wins
  }
}
