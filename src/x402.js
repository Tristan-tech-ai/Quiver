// Hand-rolled x402 v2 middleware (accepts-based, `exact` scheme, OKX facilitator).
// Flow: unpaid -> 402 + PAYMENT-REQUIRED header; paid retry carries PAYMENT-SIGNATURE
// (v2) or X-PAYMENT (v1 legacy) -> facilitator /verify -> run handler -> /settle (sync)
// -> 200 + PAYMENT-RESPONSE receipt header. Engine failure => never settled (caller
// keeps funds); settle failure => 402 again (resource not served unpaid).
import { config, atomicAmount } from './config.js';
import { okxPost } from './okxsign.js';

const b64 = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
const unb64 = (s) => JSON.parse(Buffer.from(s, 'base64').toString('utf8'));

function paymentRequirements({ priceUsdt, resourceUrl, description, inputSchema }) {
  const req = {
    scheme: 'exact',
    network: config.network,
    maxAmountRequired: atomicAmount(priceUsdt),
    amount: atomicAmount(priceUsdt),
    asset: config.asset,
    decimals: config.assetDecimals, // self-describe token decimals — the facilitator can't auto-resolve USD₮0
    payTo: config.payTo,
    maxTimeoutSeconds: config.maxTimeoutSeconds,
    resource: { url: resourceUrl, description, mimeType: 'application/json' },
    extra: {
      name: config.assetEip712Name,
      version: config.assetEip712Version,
    },
  };
  if (inputSchema) {
    // x402 Bazaar extension: declare how the paid replay must send params.
    req.outputSchema = {
      input: {
        type: 'http',
        method: 'POST',
        bodyType: 'json',
        body: inputSchema,
      },
    };
  }
  return req;
}

function respond402(res, requirementsList, resourceUrl, note) {
  const payload = {
    x402Version: 2,
    accepts: requirementsList,
    resource: { url: resourceUrl },
    error: note || 'Payment required',
  };
  res.set('PAYMENT-REQUIRED', b64(payload));
  // Body mirror aids debugging and legacy v1 clients that sniff the body.
  return res.status(402).json({ x402Version: 2, ...payload });
}

async function facilitator(pathname, body) {
  const base = config.facilitatorBase; // e.g. https://web3.okx.com/api/v6/pay/x402
  const url = new URL(base + pathname);
  return okxPost(url.pathname + url.search, body, { base: url.origin, timeoutMs: 20000 });
}

/**
 * Wrap an async business handler with the x402 payment gate.
 * handler(req) must return a JSON-serializable result object.
 */
export function paid({ priceUsdt, description, inputSchema }) {
  return (handler) => async (req, res) => {
    const resourceUrl = `${req.protocol}://${req.get('host')}${req.originalUrl.split('?')[0]}`;
    const requirements = paymentRequirements({ priceUsdt, resourceUrl, description, inputSchema });

    if (config.devMode) {
      // Local development only — the deployed service never sets DEV_MODE.
      const result = await handler(req);
      return res.status(200).json(result);
    }

    const rawHeader = req.get('PAYMENT-SIGNATURE') || req.get('X-PAYMENT');
    if (!rawHeader) return respond402(res, [requirements], resourceUrl);

    let paymentPayload;
    try {
      paymentPayload = unb64(rawHeader);
    } catch {
      return respond402(res, [requirements], resourceUrl, 'Malformed payment header');
    }

    // 1) Verify (no chain write)
    let verify;
    try {
      verify = await facilitator('/verify', {
        x402Version: 2,
        paymentPayload,
        paymentRequirements: requirements,
      });
    } catch (e) {
      return res.status(502).json({ error: 'facilitator_unreachable', detail: String(e.message || e) });
    }
    const vdata = verify.json?.data ?? verify.json ?? {};
    const isValid = vdata.isValid === true || vdata.isValid === 'true';
    if (!isValid) {
      return respond402(res, [requirements], resourceUrl, `Payment invalid: ${vdata.invalidReason || verify.json?.msg || 'verification failed'}`);
    }

    // 2) Compute the result BEFORE settling — engine failure must not charge the caller.
    let result;
    try {
      result = await handler(req);
    } catch (e) {
      return res.status(500).json({ error: 'engine_error', detail: String(e.message || e) });
    }

    // 3) Settle synchronously, then serve.
    let settle;
    try {
      settle = await facilitator('/settle', {
        x402Version: 2,
        paymentPayload,
        paymentRequirements: requirements,
        syncSettle: true,
      });
    } catch (e) {
      return res.status(502).json({ error: 'settle_unreachable', detail: String(e.message || e) });
    }
    const sdata = settle.json?.data ?? settle.json ?? {};
    const settled = sdata.success === true || sdata.success === 'true' || sdata.status === 'settled' || sdata.status === 'success';
    if (!settled) {
      return respond402(res, [requirements], resourceUrl, `Settlement failed: ${sdata.errorReason || settle.json?.msg || 'unknown'}`);
    }

    res.set('PAYMENT-RESPONSE', b64({
      success: true,
      transaction: sdata.transaction || sdata.txHash || null,
      network: config.network,
      payer: sdata.payer || vdata.payer || null,
      amount: requirements.amount,
      status: sdata.status || 'settled',
    }));
    return res.status(200).json(result);
  };
}
