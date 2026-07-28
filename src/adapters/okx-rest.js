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

// GONE FROM THE UPSTREAM API, measured 28 July 2026 rather than assumed.
//
// `/api/v6/dex/market/holders` returns HTTP 404 with `{"code":404,"error_message":"Not Found"}`, and
// so does every plausible neighbour: `/token/holders`, `/token-holders`, `/holder-list`,
// `/top-holders`. That is specifically a ROUTING miss and not an auth gate, because the other v6
// market routes answer differently when called the same way — `/token/advanced-info` returns a 402
// x402 challenge and `/price-info` answers on POST. A 404 across five spellings while its siblings
// respond is a route that was removed or renamed to something not guessable from the old name.
//
// This export has NO CALL SITES anywhere in `src/`. Every engine that reports a holder count reads
// `price.holders` out of the price-info response instead: `tokenScan.js:125`, `chartPress.js:141`,
// `tapePulse.js:208`. So nothing is degrading silently today; this is dead code pointing at a dead
// route, and the only real risk is that somebody wires it up later and discovers the 404 in
// production.
//
// It therefore fails FAST and by name rather than being deleted. Deleting it would lose the
// measurement; leaving it would hand the next caller an opaque upstream error. If OKX republishes
// holder data under a new path, replace the throw with the new route and delete this comment.
export const holders = async (chain, address) => {
  throw new Error(
    'okx holders: /api/v6/dex/market/holders returns 404 upstream (measured 2026-07-28, along with '
    + '/token/holders, /token-holders, /holder-list and /top-holders). No replacement route is known. '
    + 'Holder counts currently come from price-info via `price.holders`, not from here.'
  );
};

export const portfolioOverview = (chain, address, timeFrame = 4) =>
  getData(`/api/v6/dex/market/portfolio/overview?chainIndex=${idx(chain)}&walletAddress=${address}&timeFrame=${timeFrame}`);

export const portfolioDexHistory = (chain, address) =>
  getData(`/api/v6/dex/market/portfolio/dex-history?chainIndex=${idx(chain)}&walletAddress=${address}`);

export const recentPnl = (chain, address) =>
  getData(`/api/v6/dex/market/portfolio/recent-pnl?chainIndex=${idx(chain)}&walletAddress=${address}`);

// OHLC candles (PROVEN: /api/v6/dex/market/candles → [[ts,o,h,l,c,vol,...],...]). bar e.g. 1m,5m,1H,4H,1D.
// The unit letter is upper-cased before it goes upstream, and that is a bug fix rather than tidiness.
//
// The CEX path normalises through `mapBar()` in okx-market.js; this DEX path passed `bar` through
// untouched, so a caller asking for `1h` got whatever OKX makes of a lowercase unit while the same
// caller asking `1H` was served. chart-press then reported DATA_UNAVAILABLE and attributed it to an
// upstream outage, which is a service telling a buyer something false about why it could not answer.
//
// HONEST LIMIT ON WHAT I VERIFIED. The asymmetry between the two paths is read directly from the
// code and is certain. The upstream rejection of a lowercase unit is NOT something I could reproduce:
// unkeyed, the x402 pay-gate answers 402 before any parameter is validated, so `1h` and `1H` are
// indistinguishable from outside. That half rests on a keyed measurement reported as error 51000, and
// the fix is written to be harmless either way — upper-casing a unit letter cannot break a bar code
// that was already upper-case, which is every bar code the engines pass today.
// `m` IS DELIBERATELY NOT TOUCHED, and this line is the whole reason this comment exists. The first
// version of this fix upper-cased any trailing letters, which turned `15m` into `15M`. In OKX's
// vocabulary `1m` is one MINUTE and `1M` is one MONTH, so a blanket case fix silently converts a
// minute chart into a monthly one and every downstream number stays plausible. Caught by printing the
// normaliser's output over a list of inputs before trusting it, which took one command.
//
// Only h, d and w are case-corrected, because those are unambiguous: OKX writes them upper-case and
// has no lower-case meaning for any of them. The CEX table in okx-market.js is the reference and it
// agrees: `15m` stays `15m`, `1h` becomes `1H`, `1d` becomes `1Dutc`.
const normaliseBar = (bar) => String(bar || '1H').replace(/([hdw])$/, (u) => u.toUpperCase());

export const candles = (chain, address, bar = '1H', limit = 48) =>
  getData(`/api/v6/dex/market/candles?chainIndex=${idx(chain)}&tokenContractAddress=${address}&bar=${normaliseBar(bar)}&limit=${Math.min(limit, 300)}`);

// --- POST endpoints (GET returns "method not supported"); price-info takes a batch array ---
export const priceInfo = (chain, address) =>
  postData('/api/v6/dex/market/price-info', [{ chainIndex: idx(chain), tokenContractAddress: address }])
    .then((d) => (Array.isArray(d) ? d[0] : d) || {});

// cluster-overview has no v6 REST path (404); skip gracefully — holder-funding prior unavailable.
export const clusterOverview = async () => ({});

export const bundleInfo = async () => ({});
