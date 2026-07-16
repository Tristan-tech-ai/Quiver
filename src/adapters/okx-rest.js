// Deployed backend: OKX Web3 DEX Market API v6 with dev-portal keys (OK-ACCESS-* HMAC).
// Paths + methods verified empirically against the live API (Jul 11). OK-ACCESS auth
// bypasses the endpoints' x402 pay-gate. GET endpoints carry query params; the two POST
// endpoints (price-info, cluster-overview) take a JSON body.
import { okxGet, okxPost } from '../okxsign.js';
import { config } from '../config.js';

export const name = 'rest';

const CHAIN_INDEX = { ethereum: '1', solana: '501', base: '8453', bsc: '56', xlayer: '196', polygon: '137', arbitrum: '42161' };
const idx = (chain) => CHAIN_INDEX[String(chain).toLowerCase()] || String(chain);

function ensureKeys() {
  if (!config.okxApiKey) throw new Error('rest adapter needs OKX_API_KEY/OKX_SECRET_KEY/OKX_PASSPHRASE env');
}

async function getData(path) {
  ensureKeys();
  const { status, json } = await okxGet(path, { timeoutMs: config.upstreamTimeoutMs });
  if (status !== 200 || (json.code !== undefined && String(json.code) !== '0')) {
    throw new Error(`okx GET ${path.split('?')[0]} -> ${status} ${JSON.stringify(json).slice(0, 200)}`);
  }
  return json.data;
}

async function postData(pathname, body) {
  ensureKeys();
  const { status, json } = await okxPost(pathname, body, { timeoutMs: config.upstreamTimeoutMs });
  if (status !== 200 || (json.code !== undefined && String(json.code) !== '0')) {
    throw new Error(`okx POST ${pathname} -> ${status} ${JSON.stringify(json).slice(0, 200)}`);
  }
  return json.data;
}

// --- confirmed GET endpoints ---
export const trades = (chain, address, limit = config.tapeLimit) =>
  getData(`/api/v6/dex/market/trades?chainIndex=${idx(chain)}&tokenContractAddress=${address}&limit=${Math.min(limit, 500)}`);

export const advancedInfo = (chain, address) =>
  getData(`/api/v6/dex/market/token/advanced-info?chainIndex=${idx(chain)}&tokenContractAddress=${address}`);

export const holders = (chain, address) =>
  getData(`/api/v6/dex/market/holders?chainIndex=${idx(chain)}&tokenContractAddress=${address}`);

export const portfolioOverview = (chain, address, timeFrame = 4) =>
  getData(`/api/v6/dex/market/portfolio/overview?chainIndex=${idx(chain)}&walletAddress=${address}&timeFrame=${timeFrame}`);

export const portfolioDexHistory = (chain, address) =>
  getData(`/api/v6/dex/market/portfolio/dex-history?chainIndex=${idx(chain)}&walletAddress=${address}`);

export const recentPnl = (chain, address) =>
  getData(`/api/v6/dex/market/portfolio/recent-pnl?chainIndex=${idx(chain)}&walletAddress=${address}`);

// OHLC candles (PROVEN: /api/v6/dex/market/candles → [[ts,o,h,l,c,vol,...],...]). bar e.g. 1m,5m,1H,4H,1D.
export const candles = (chain, address, bar = '1H', limit = 48) =>
  getData(`/api/v6/dex/market/candles?chainIndex=${idx(chain)}&tokenContractAddress=${address}&bar=${bar}&limit=${Math.min(limit, 300)}`);

// --- POST endpoints (GET returns "method not supported"); price-info takes a batch array ---
export const priceInfo = (chain, address) =>
  postData('/api/v6/dex/market/price-info', [{ chainIndex: idx(chain), tokenContractAddress: address }])
    .then((d) => (Array.isArray(d) ? d[0] : d) || {});

// cluster-overview has no v6 REST path (404); skip gracefully — holder-funding prior unavailable.
export const clusterOverview = async () => ({});

export const bundleInfo = async () => ({});
