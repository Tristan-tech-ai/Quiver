// Central config — everything env-driven, sane defaults for X Layer USDT.
const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);

// ── Payment networks. Quiver advertises an x402 `accepts` entry per configured network, and routes
//    verify/settle to that network's own facilitator. The primary (X Layer / OKX facilitator) is always
//    present. Base activates ONLY when BASE_ASSET and BASE_FACILITATOR are both set — until then behaviour
//    is byte-identical to single-network X Layer, so this change is dormant and cannot affect the live loop.
const primaryNet = {
  key: 'xlayer',
  network: env('X402_NETWORK', 'eip155:196'),
  asset: env('X402_ASSET', '0x779Ded0c9e1022225f8E0630b35a9b54bE713736'), // USDT on X Layer
  assetDecimals: Number(env('X402_ASSET_DECIMALS', 6)),
  payTo: env('PAY_TO', '0x65bb932d9987f1d1a98b8942a3fa98cb28ec073b'),
  facilitatorBase: env('OKX_FACILITATOR_BASE', 'https://web3.okx.com/api/v6/pay/x402'),
  facilitatorAuth: 'okx', // OKX facilitator needs signed requests (okxsign.js)
  facilitatorToken: '',
  eip712Name: env('X402_ASSET_712_NAME', 'USDT'),
  eip712Version: env('X402_ASSET_712_VERSION', '2'),
};

// Base (second EVM network). The real Base facilitator is Coinbase's CDP x402 service at
// api.cdp.coinbase.com/platform/v2/x402, which authenticates with CDP_API_KEY_ID + CDP_API_KEY_SECRET
// (a per-request JWT minted by the official @coinbase/x402 SDK — NOT a static bearer token). Under x402
// version 2 the chain is CAIP-2 "eip155:8453" (CERTIFIED against CDP /supported: CDP exposes Base as both a
// legacy v1 "base"/exact kind and a v2 "eip155:8453"/exact kind — Quiver speaks v2, so it uses eip155:8453).
// Auth modes: 'cdp' (CDP keys), 'bearer' (static Authorization: Bearer <token>), 'none' (testnet, unauth).
//
// FAIL-SAFE: a network is advertised ONLY when its facilitator can actually verify+settle. A half-config
// (asset set, credentials missing) stays DORMANT — advertising a rail we cannot settle would 402 real payers
// *after* they have signed an authorization. With no CDP keys, behaviour is byte-identical to single-network
// X Layer, so this remains inert until the operator supplies credentials.
const CDP_FACILITATOR_URL = 'https://api.cdp.coinbase.com/platform/v2/x402';
const baseAuth = env('BASE_FACILITATOR_AUTH', 'cdp');
const cdpKeysPresent = !!(env('CDP_API_KEY_ID', '') && env('CDP_API_KEY_SECRET', ''));
const baseFacilitatorUsable =
  baseAuth === 'none' ? true
    : baseAuth === 'bearer' ? !!env('BASE_FACILITATOR_TOKEN', '')
      : cdpKeysPresent; // 'cdp' — the default; needs both CDP keys to settle
const baseNet = (env('BASE_ASSET', '') && baseFacilitatorUsable)
  ? {
      key: 'base',
      network: env('BASE_NETWORK', 'eip155:8453'), // CDP Base under x402 v2 (certified via /supported)
      asset: env('BASE_ASSET'), // USDC on Base, e.g. 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
      assetDecimals: Number(env('BASE_ASSET_DECIMALS', 6)),
      payTo: env('BASE_PAY_TO', '') || primaryNet.payTo,
      facilitatorBase: env('BASE_FACILITATOR', '') || CDP_FACILITATOR_URL, // CDP x402 facilitator base URL
      facilitatorAuth: baseAuth,
      facilitatorToken: env('BASE_FACILITATOR_TOKEN', ''),
      eip712Name: env('BASE_ASSET_712_NAME', 'USD Coin'), // USDC EIP-712 domain name
      eip712Version: env('BASE_ASSET_712_VERSION', '2'),
    }
  : null;

export const config = {
  port: Number(env('PORT', 8402)),

  // Flat payment identity = primary network (kept for backward compat: app.js index, atomicAmount default).
  payTo: primaryNet.payTo,
  network: primaryNet.network,
  asset: primaryNet.asset,
  assetDecimals: primaryNet.assetDecimals,
  assetEip712Name: primaryNet.eip712Name,
  assetEip712Version: primaryNet.eip712Version,
  facilitatorBase: primaryNet.facilitatorBase,
  maxTimeoutSeconds: Number(env('X402_MAX_TIMEOUT', 300)),

  // The networks x402 advertises + routes by. One entry (X Layer) unless Base is configured.
  networks: baseNet ? [primaryNet, baseNet] : [primaryNet],

  // Prices in USDT (human units, converted to atomic in x402.js). Calibrated to the observed
  // marketplace winner cluster (0.001-0.01 high-volume; CoinAnk's 1457 sales sit at 0.01).
  prices: {
    tokenScan: env('PRICE_TOKEN_SCAN', '0.05'),
    walletAudit: env('PRICE_WALLET_AUDIT', '0.05'),
    tapePulse: env('PRICE_TAPE_PULSE', '0.01'),
    chartPress: env('PRICE_CHART_PRESS', '0.02'),
    polyFill: env('PRICE_POLY_FILL', '0.01'),
    polyDesk: env('PRICE_POLY_DESK', '0.01'),
    optionsDesk: env('PRICE_OPTIONS_DESK', '0.01'),
    lpDesk: env('PRICE_LP_DESK', '0.01'),
    calldata: env('PRICE_CALLDATA', '0.005'),
    protocolPulse: env('PRICE_PROTOCOL_PULSE', '0.01'),
    upDownPulse: env('PRICE_UPDOWN_PULSE', '0.01'),
    loopDigest: env('PRICE_LOOP_DIGEST', '0.01'),
    macroSentry: env('PRICE_MACRO_SENTRY', '0.005'),
    perpGate: env('PRICE_PERP_GATE', '0.01'),
    portfolioGate: env('PRICE_PORTFOLIO_GATE', '0.05'), // composite "bundle": exposure + nearest-liq + correlated stress in one call
    sizeGate: env('PRICE_SIZE_GATE', '0.01'),
    execVerify: env('PRICE_EXEC_VERIFY', '0.01'),
    optionsRisk: env('PRICE_OPTIONS_RISK', '0.02'),
    lpRisk: env('PRICE_LP_RISK', '0.01'),
    treasuryRisk: env('PRICE_TREASURY_RISK', '0.02'),
    riskAttest: env('PRICE_RISK_ATTEST', '0.01'),
    eventVol: env('PRICE_EVENT_VOL', '0.01'),
  },

  // OKX facilitator + dev-portal API auth
  okxApiBase: env('OKX_API_BASE', 'https://web3.okx.com'),
  okxApiKey: env('OKX_API_KEY', ''),
  okxSecretKey: env('OKX_SECRET_KEY', ''),
  okxPassphrase: env('OKX_PASSPHRASE', ''),

  // Behavior flags
  devMode: env('DEV_MODE', '') === '1', // local only: skips payment gate entirely
  adapter: env('DATA_ADAPTER', 'auto'), // cli | rest | auto
  onchainosBin: env('ONCHAINOS_BIN', 'C:\\Users\\Tristan\\.local\\bin\\onchainos.exe'),

  // Engine bounds
  tapeLimit: Number(env('TAPE_LIMIT', 500)),
  upstreamTimeoutMs: Number(env('UPSTREAM_TIMEOUT_MS', 12000)),
  cacheTtlMs: Number(env('CACHE_TTL_MS', 120000)),

  version: '0.1.0',
};

export function atomicAmount(usdtHuman, decimals = config.assetDecimals) {
  // "0.1" -> "100000" at 6 decimals, string-safe (no float drift)
  const [int, frac = ''] = String(usdtHuman).split('.');
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return String(BigInt(int || '0') * 10n ** BigInt(decimals) + BigInt(fracPadded || '0'));
}
