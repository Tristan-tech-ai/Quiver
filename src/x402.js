// Hand-rolled x402 v2 middleware (accepts-based, `exact` scheme). Multi-network: advertises one `accepts`
// entry per configured network (X Layer via the OKX facilitator; optionally Base via the CDP facilitator)
// and routes /verify + /settle to the facilitator of whichever network the payer actually used.
// Flow: unpaid -> 402 + PAYMENT-REQUIRED header (all accepts); paid retry carries PAYMENT-SIGNATURE
// (v2) or X-PAYMENT (v1 legacy) -> matched facilitator /verify -> run handler -> /settle (sync)
// -> 200 + PAYMENT-RESPONSE receipt header. Engine failure => never settled (caller keeps funds);
// settle failure => 402 again (resource not served unpaid).
import { config, atomicAmount } from './config.js';
import { okxPost } from './okxsign.js';
import { recordCall } from './recurrence.js';

const b64 = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
const unb64 = (s) => JSON.parse(Buffer.from(s, 'base64').toString('utf8'));

// Billing contract: a caller is charged only for a DELIVERED result. An answer the engine itself
// rejected as invalid input (`ok:false`) is not a delivery — it must be FREE, uniformly with the
// validation-throw path (which already fails before settlement). This closes the inconsistency where
// input that slipped past `validate()` but was rejected inside the engine got settled while a thrown
// validation error did not. Pure + exported so the rule is unit-locked without a live facilitator.
// A second, narrower condition was added after a payment-surface audit: an answer whose own
// ground-truth self-check FAILED is not a delivered result either. Overflow inputs made two engines
// return `ok:true` alongside `allSelfChecksPass:false` — the engine sanitized the arithmetic to null
// and its self-check correctly caught the violation, but billing keyed off `ok` alone, so a caller
// paid for a number the engine itself had already flagged as unproven.
//
// This gates BILLING, not delivery. The answer is still served with the failed check disclosed in its
// envelope — that disclosure is deliberate, and converting every failed check into a refusal would
// withhold answers that are merely at the edge of a numerical tolerance. The asymmetry is what makes
// the rule safe in that direction: not charging for a borderline answer costs us a fraction of a
// cent, while charging for one we ourselves refused to stand behind takes a buyer's money for it.
export function isChargeable(result) {
  if (!result || typeof result !== 'object') return true; // defensive: never skip settlement on a malformed result
  if (result.ok === false) return false;
  // Read the published envelope field first — it is the one the response advertises and the paper names
  // — then fall back to the raw checks, so the rule holds on a result whose envelope was not attached.
  const attested = result.proof || result.observation;
  if (attested && attested.allSelfChecksPass === false) return false;
  const checks = Array.isArray(result.checks) ? result.checks : [];
  return !checks.some((c) => c && c.pass === false);
}

// Normalize the facilitator's settlement status for the receipt. The OKX facilitator can report
// status:"timeout" (its confirmation poll timed out) even when success:true and a txHash exists — a
// contradictory "success + timeout" that a status-respecting client could mis-retry on. Once we've
// determined the payment settled, the honest label is a settled one.
export function settledStatus(sdata) {
  return ['settled', 'success', 'confirmed'].includes(sdata.status) ? sdata.status : 'settled';
}

// Settlement acceptance (BUG-011, buyer-desk reconciliation): a settle response of success:true with
// status:"timeout" and NO transaction hash empirically never lands on-chain (68/68 such calls in the
// day-1 desk ledger produced no transfer — a silent ~7% revenue leak), while responses carrying a
// transaction hash land (sampled 5/5, receipt status 0x1). The transaction field — not the success
// flag — is the discriminator. success-without-transaction earns ONE idempotent retry (EIP-3009
// nonces make a duplicate /settle harmless: if the first actually landed, the second cannot
// double-spend); still nothing => NOT settled, and the caller (who keeps their funds) gets a 402.
export function settleDecision(sdata) {
  const hasTx = !!(sdata.transaction || sdata.txHash);
  const confirmed = ['settled', 'success', 'confirmed'].includes(sdata.status);
  const success = sdata.success === true || sdata.success === 'true';
  if (hasTx && (success || confirmed)) return 'settled';
  if (confirmed) return 'settled';
  if (success) return 'retry';
  return 'failed';
}

function paymentRequirements(net, { priceUsdt, resourceUrl, description, inputSchema }) {
  const req = {
    scheme: 'exact',
    network: net.network,
    maxAmountRequired: atomicAmount(priceUsdt, net.assetDecimals),
    amount: atomicAmount(priceUsdt, net.assetDecimals),
    asset: net.asset,
    decimals: net.assetDecimals, // self-describe token decimals — the facilitator can't auto-resolve USD₮0
    payTo: net.payTo,
    maxTimeoutSeconds: config.maxTimeoutSeconds,
    resource: { url: resourceUrl, description, mimeType: 'application/json' },
    extra: {
      name: net.eip712Name,
      version: net.eip712Version,
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

// Lazy CDP auth — the official @coinbase/x402 SDK mints a fresh JWT per call, endpoint-bound (verify vs
// settle). Imported only when a Base/CDP network is actually exercised, so the single-network X Layer path
// never touches the dependency. Reads CDP_API_KEY_ID / CDP_API_KEY_SECRET from the env at call time.
let _cdpCreateAuthHeaders;
async function cdpAuthHeaders(pathname) {
  if (!_cdpCreateAuthHeaders) {
    const { facilitator } = await import('@coinbase/x402');
    _cdpCreateAuthHeaders = facilitator.createAuthHeaders;
  }
  const all = await _cdpCreateAuthHeaders();
  return pathname.includes('/settle') ? all.settle : all.verify;
}

// Route a facilitator call to the right backend + auth for the given network.
async function facilitator(net, pathname, body) {
  if (net.facilitatorAuth === 'okx') {
    const url = new URL(net.facilitatorBase + pathname);
    return okxPost(url.pathname + url.search, body, { base: url.origin, timeoutMs: 20000 });
  }
  // 'cdp' (Coinbase CDP per-request JWT) | 'bearer' (static token) | 'none' (testnet) — plain JSON POST.
  const headers = { 'content-type': 'application/json' };
  if (net.facilitatorAuth === 'cdp') {
    Object.assign(headers, await cdpAuthHeaders(pathname));
  } else if (net.facilitatorAuth === 'bearer' && net.facilitatorToken) {
    headers.authorization = `Bearer ${net.facilitatorToken}`;
  }
  const res = await fetch(net.facilitatorBase + pathname, {
    method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
  });
  const json = await res.json().catch(() => ({}));
  return { json, status: res.status };
}

// Which configured network did the payer pay on? Match the decoded payload's network; default to primary.
function matchNetwork(paymentPayload) {
  const netId = paymentPayload?.network || paymentPayload?.payload?.network || paymentPayload?.paymentRequirements?.network;
  return config.networks.find((n) => n.network === netId) || config.networks[0];
}

// Gated diagnostic — probe CDP /verify with a synthetic payload against the LIVE Base requirements, to
// certify (or expose) the paymentRequirements shape without a real payer. Returns the RAW facilitator
// response so we can see exactly what CDP validates. Read-only: /verify never moves funds.
export async function _probeCdpVerify(paymentPayload) {
  const net = config.networks.find((n) => n.facilitatorAuth === 'cdp');
  if (!net) return { error: 'no CDP network active' };
  const requirements = paymentRequirements(net, {
    priceUsdt: '0.01',
    resourceUrl: 'https://quiver-production-c3a8.up.railway.app/api/perp-gate',
    description: 'cdp verify probe',
    inputSchema: null,
  });
  // x402 v2 PaymentPayload carries `accepted` (the requirement the client chose). A real client library fills
  // this from our 402 accepts; inject it here so the probe reaches CDP's signature check rather than a shape error.
  const payload = { ...paymentPayload, accepted: requirements };
  const out = await facilitator(net, '/verify', { x402Version: 2, paymentPayload: payload, paymentRequirements: requirements });
  return { httpStatus: out.status, cdpResponse: out.json, requirementsSent: requirements };
}

/**
 * Wrap an async business handler with the x402 payment gate.
 * handler(req) must return a JSON-serializable result object.
 */
export function paid({ priceUsdt, description, inputSchema }) {
  return (handler) => async (req, res) => {
    const resourceUrl = `${req.protocol}://${req.get('host')}${req.originalUrl.split('?')[0]}`;
    const accepts = config.networks.map((net) => paymentRequirements(net, { priceUsdt, resourceUrl, description, inputSchema }));

    if (config.devMode) {
      // Local development only — the deployed service never sets DEV_MODE.
      const result = await handler(req);
      return res.status(200).json(result);
    }

    const rawHeader = req.get('PAYMENT-SIGNATURE') || req.get('X-PAYMENT');
    if (!rawHeader) return respond402(res, accepts, resourceUrl);

    let paymentPayload;
    try {
      paymentPayload = unb64(rawHeader);
    } catch {
      return respond402(res, accepts, resourceUrl, 'Malformed payment header');
    }

    // Route to the network the payer used, and the exact requirement they paid against.
    const net = matchNetwork(paymentPayload);
    const requirements = accepts.find((r) => r.network === net.network) || accepts[0];

    // 1) Verify (no chain write)
    let verify;
    try {
      verify = await facilitator(net, '/verify', {
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
      return respond402(res, accepts, resourceUrl, `Payment invalid: ${vdata.invalidReason || verify.json?.msg || 'verification failed'}`);
    }

    // 2) Compute the result BEFORE settling — engine failure must not charge the caller.
    let result;
    try {
      result = await handler(req);
    } catch (e) {
      // Respect an explicit status set by the handler: a business-input rejection carries status 400
      // (`bad_input`) and must not masquerade as a server fault (500) that trips buyer monitoring.
      const status = Number.isInteger(e?.status) ? e.status : 500;
      const code = status >= 400 && status < 500 ? 'bad_input' : 'engine_error';
      return res.status(status).json({ error: code, detail: String(e.message || e).replace(/^bad_input:\s*/, '') });
    }

    // 2b) An input the engine rejected (ok:false) is not a delivered result — do NOT settle. The caller
    // gets the rejection (with its reasons) for free, consistent with the validation-throw path above.
    if (!isChargeable(result)) {
      res.set('PAYMENT-RESPONSE', b64({ success: false, status: 'not_charged', reason: 'input rejected by engine — no settlement', network: requirements.network }));
      return res.status(200).json(result);
    }

    // 3) Settle synchronously, then serve.
    let settle;
    try {
      settle = await facilitator(net, '/settle', {
        x402Version: 2,
        paymentPayload,
        paymentRequirements: requirements,
        syncSettle: true,
      });
    } catch (e) {
      return res.status(502).json({ error: 'settle_unreachable', detail: String(e.message || e) });
    }
    let sdata = settle.json?.data ?? settle.json ?? {};
    let decision = settleDecision(sdata);
    // Settle observability (BUG-011 postmortem gap: nothing recorded the facilitator's raw answer,
    // so the leak was only measurable from the BUYER's ledger). One line per settle, always.
    console.log(JSON.stringify({ evt: 'settle', network: requirements.network, decision, status: sdata.status ?? null, success: sdata.success ?? null, tx: sdata.transaction || sdata.txHash || null }));
    if (decision === 'retry') {
      try {
        const again = await facilitator(net, '/settle', { x402Version: 2, paymentPayload, paymentRequirements: requirements, syncSettle: true });
        sdata = again.json?.data ?? again.json ?? {};
      } catch { /* keep the first response; the decision below rules */ }
      decision = settleDecision(sdata);
      console.log(JSON.stringify({ evt: 'settle_retry', network: requirements.network, decision, status: sdata.status ?? null, success: sdata.success ?? null, tx: sdata.transaction || sdata.txHash || null }));
    }
    if (decision !== 'settled') {
      return respond402(res, accepts, resourceUrl, decision === 'retry'
        ? 'Settlement unconfirmed: the facilitator reported success without a transaction hash twice — the payment was NOT captured and you were not charged; please retry.'
        : `Settlement failed: ${sdata.errorReason || settle.json?.msg || 'unknown'}`);
    }

    try { recordCall(sdata.payer || vdata.payer, (req.path || '').replace(/^\/api\//, '')); } catch { /* instrumentation must never break a paid call */ }
    res.set('PAYMENT-RESPONSE', b64({
      success: true,
      transaction: sdata.transaction || sdata.txHash || null,
      network: requirements.network,
      payer: sdata.payer || vdata.payer || null,
      amount: requirements.amount,
      status: settledStatus(sdata),
    }));
    return res.status(200).json(result);
  };
}
