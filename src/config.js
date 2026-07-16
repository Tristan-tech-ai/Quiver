// Central config — everything env-driven, sane defaults for X Layer USDT.
const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);

export const config = {
  port: Number(env('PORT', 8402)),

  // Payment identity
  payTo: env('PAY_TO', '0x65bb932d9987f1d1a98b8942a3fa98cb28ec073b'),
  network: env('X402_NETWORK', 'eip155:196'), // X Layer
  asset: env('X402_ASSET', '0x779Ded0c9e1022225f8E0630b35a9b54bE713736'), // USDT on X Layer
  assetDecimals: Number(env('X402_ASSET_DECIMALS', 6)),
  // EIP-712 domain hints for the exact scheme (verified empirically in the paid-loop self-test;
  // the facilitator rejects mismatches, so these are corrected there if wrong).
  assetEip712Name: env('X402_ASSET_712_NAME', 'USDT'),
  assetEip712Version: env('X402_ASSET_712_VERSION', '2'),
  maxTimeoutSeconds: Number(env('X402_MAX_TIMEOUT', 300)),

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
    calldata: env('PRICE_CALLDATA', '0.005'),
    pawCheck: env('PRICE_PAW_CHECK', '0.01'),
    protocolPulse: env('PRICE_PROTOCOL_PULSE', '0.01'),
    upDownPulse: env('PRICE_UPDOWN_PULSE', '0.01'),
    loopDigest: env('PRICE_LOOP_DIGEST', '0.01'),
    macroSentry: env('PRICE_MACRO_SENTRY', '0.005'),
  },

  // OKX facilitator + dev-portal API auth
  facilitatorBase: env('OKX_FACILITATOR_BASE', 'https://web3.okx.com/api/v6/pay/x402'),
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

export function atomicAmount(usdtHuman) {
  // "0.1" -> "100000" at 6 decimals, string-safe (no float drift)
  const [int, frac = ''] = String(usdtHuman).split('.');
  const fracPadded = (frac + '0'.repeat(config.assetDecimals)).slice(0, config.assetDecimals);
  return String(BigInt(int || '0') * 10n ** BigInt(config.assetDecimals) + BigInt(fracPadded || '0'));
}
