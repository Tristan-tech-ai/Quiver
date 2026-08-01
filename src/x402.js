// x402 payment layer, built on the OFFICIAL OKX Payment SDK (@okxweb3/x402-express + x402-core).
//
// WHY THIS WAS REWRITTEN. Quiver was delisted from OKX.AI on 1 August 2026 with one stated reason:
// "your service is not integrated with the official OKX Payment SDK, which prevents us from completing
// verification." The previous implementation here was a hand-rolled x402 v2 `exact` middleware. It was
// not broken — OKX's own `agent x402-check` passed all 22 endpoints on the day of the delisting, and
// `validate-listing` returned zero findings — but a spec-correct reimplementation is not what their
// review verifies. It verifies the SDK. So the protocol mechanics (402 challenge, /verify, /settle,
// receipt headers, network routing) now belong to the SDK, and this file keeps only the things that are
// Quiver's own policy rather than the protocol's.
//
// WHAT SURVIVED, AND HOW. Each of these was checked against the SDK's compiled source, not its docs:
//   · Dual rail. `RouteConfig.accepts` takes an ARRAY of PaymentOption, so one 402 still advertises
//     X Layer USD₮0 and Base USDC together.
//   · The EIP-712 domain fix. `PaymentOption.extra` is passed through to PaymentRequirements verbatim,
//     so `{name: 'USD₮0', version: '1'}` still reaches the payer. Getting this wrong once already made
//     the X Layer rail unsignable for every buyer, so `price` is given in the explicit
//     `{asset, amount, extra}` form — no token registry gets a chance to resolve USD₮0 for us.
//   · Refusals stay free. The SDK's Express middleware buffers the handler's response and, at
//     `if (res.statusCode >= 400)`, flushes it and RETURNS WITHOUT SETTLING. So a 4xx/5xx is now the
//     mechanism by which a caller is not charged. That is why `isChargeable` no longer serves 200.
//   · The BUG-011 rule (a settle reporting success with no transaction hash never landed on-chain) maps
//     to the SDK's `onSettlementTimeout` hook, which exists precisely to let the server confirm on-chain
//     and answer `{confirmed:false}` so the caller keeps their funds.
//
// The client-facing header is unchanged: the SDK reads `payment-signature`, exactly as before.
import { paymentMiddleware } from '@okxweb3/x402-express';
import { OKXFacilitatorClient } from '@okxweb3/x402-core';
import { HTTPFacilitatorClient, x402ResourceServer } from '@okxweb3/x402-core/server';
import { config, atomicAmount } from './config.js';
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
// This gates BILLING, not delivery. The answer is still served in full with the failed check disclosed
// in its envelope — that disclosure is deliberate, and converting every failed check into a refusal
// would withhold answers that are merely at the edge of a numerical tolerance. The asymmetry is what
// makes the rule safe in that direction: not charging for a borderline answer costs us a fraction of a
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

// The status code a non-chargeable answer must carry, and the one genuine API-contract change in this
// migration. It exists because "don't settle" is no longer something this file decides — the SDK decides
// it, from the status code, at `if (res.statusCode >= 400)`. Serving these 200 would charge for them.
//
// The two cases are not the same thing and do not deserve the same code:
//   · `ok:false` is the engine rejecting the caller's input. 400 is what the validation-throw path
//     already returns for the same class of problem, so this makes the two consistent rather than
//     leaving one of them at 200 as an accident of which layer caught it.
//   · a failed self-check is NOT the caller's fault and must not read as one. 422 says the request was
//     understood and we computed something we will not stand behind. It is not a 5xx either: nothing
//     malfunctioned, the self-check did its job.
// The response BODY is unchanged in both cases — a caller loses no information, only the 200.
export function nonChargeableStatus(result) {
  return result && result.ok === false ? 400 : 422;
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
// SECOND LEAK, measured 27 July 2026. The rule above was applied to `status:"timeout"` and not to the
// branch beneath it: `if (confirmed) return 'settled'` accepted `status:"success"` with NO transaction
// hash. An external address then made seven calls across five services in one session; all seven were
// logged `decision="settled" success=true tx=null`, and an exhaustive scan of the X Layer USD₮0
// transfer log over the exact block window (66,399,800–66,401,300, full coverage, no gaps) found
// **zero** transfers arriving at our payTo. Seven answers were served for nothing, and the recurrence
// instrumentation counted them as paid calls — so the defect was about to be reported as traction.
//
// The stated principle was right and the code contradicted it one line later, which is the same
// branch-next-door shape this project keeps finding. A response without a transaction hash now earns
// the same single idempotent retry regardless of how confident its status string is, and then fails
// closed: the caller keeps their funds and gets a 402 rather than a free answer.
export function settleDecision(sdata) {
  const hasTx = !!(sdata.transaction || sdata.txHash);
  const confirmed = ['settled', 'success', 'confirmed'].includes(sdata.status);
  const success = sdata.success === true || sdata.success === 'true';
  if (hasTx && (success || confirmed)) return 'settled';
  if (success || confirmed) return 'retry';
  return 'failed';
}

// The teaching half of a refusal, and the line that used to throw it away.
//
// `src/app.js` builds a refusal as an Error whose MESSAGE names what went wrong and whose `detail`
// OBJECT carries the machine-readable half: `howToFix` (a body that would work, with the caller's own
// values kept and the gaps as visible placeholders), `routingNotice` (the service that fits, with its
// endpoint, price and a retry line) and `repairsApplied` (the shape fixes made before the refusal).
// The free MCP path attaches all three. THIS path serialised `String(e.message)` into a field it also
// called `detail` and dropped the object entirely — so the surface that BILLS was the one surface with
// no corrected body on it. The OKX listing points at these paid endpoints for 13 of the 22 services,
// and the whole buyer-defence effort had been built on the surface that does not bill.
//
// Three properties this function has to hold, all asserted in gates/gateP-paid-teaching.mjs rather
// than reasoned about here:
//   · `error` and `detail` are written FIRST and never overwritten, so nothing a handler puts in
//     `detail` can rename the status code or replace the message.
//   · `undefined` members are dropped, so `repairsApplied: undefined` stays absent rather than
//     becoming `null` in the JSON.
//   · nothing here reaches a proof envelope. A refusal carries no contentHash, and this path returns
//     BEFORE settlement is ever reached — so a refusal that teaches is still a refusal that is free.
// Only a 4xx carries the teaching: a 5xx is our fault, not the caller's, and has nothing to correct.
export function refusalBody(e, status, code) {
  const body = { error: code, detail: String(e?.message || e).replace(/^bad_input:\s*/, '') };
  const teach = status >= 400 && status < 500 ? e?.detail : null;
  if (teach && typeof teach === 'object' && !Array.isArray(teach)) {
    for (const [k, v] of Object.entries(teach)) if (v !== undefined && !(k in body)) body[k] = v;
  }
  return body;
}

// One payment option per configured network. `price` is given in the explicit AssetAmount form
// (`{asset, amount, extra}`) rather than as a dollar string, because the dollar form asks the SDK to
// resolve a token for us and USD₮0 is not a token any registry can be assumed to know. The atomic
// amount is still computed by our own `atomicAmount`, so the number on the wire is unchanged.
export function acceptsFor(priceUsdt) {
  return config.networks.map((net) => {
    const extra = {
      name: net.eip712Name,
      version: net.eip712Version,
      decimals: net.assetDecimals, // self-describe: the facilitator can't auto-resolve USD₮0's decimals
    };
    return {
      scheme: 'exact',
      network: net.network,
      payTo: net.payTo,
      price: { asset: net.asset, amount: atomicAmount(priceUsdt, net.assetDecimals), extra },
      maxTimeoutSeconds: config.maxTimeoutSeconds,
      extra,
    };
  });
}

// Server-side `exact` scheme for EVM networks.
//
// This has to exist here because @okxweb3/x402-evm@0.2.1 ships only the CLIENT half: `ExactEvmScheme`
// has exactly two methods, `constructor` and `createPaymentPayload`, and nothing in the package
// implements SchemeNetworkServer. Without a server registration the middleware still answers 402, but
// with an EMPTY `accepts[]` — the precise failure that makes an ASP unusable and that several others in
// this cohort shipped. It was caught here by probing the challenge rather than by trusting the boot.
//
// The interface is three members and this implementation is deliberately thin: the amount and the asset
// were already resolved by `acceptsFor` from our own config, so there is nothing left to convert.
class ExactEvmServerScheme {
  constructor() {
    this.scheme = 'exact';
  }

  // We always hand `price` in the explicit `{asset, amount, extra}` form, so this is an identity with a
  // guard rather than a converter. It throws instead of guessing: a price this function cannot read is
  // a configuration mistake, and inventing an amount here would mean charging a number nobody chose.
  async parsePrice(price) {
    if (price && typeof price === 'object' && typeof price.asset === 'string' && typeof price.amount === 'string') {
      return { asset: price.asset, amount: price.amount, extra: price.extra };
    }
    throw new Error(`exact/EVM: price must be an explicit {asset, amount} — got ${JSON.stringify(price)}`);
  }

  // OUR `extra` wins over whatever the facilitator advertises for this kind. That ordering is the whole
  // point: `{name: 'USD₮0', version: '1'}` was measured against the token's own EIP-712 domain on
  // chain, and an earlier build that carried the wrong pair made every buyer signature rejected by the
  // token while every one of our own checks stayed green. The facilitator's values are merged in
  // underneath so nothing it adds is lost, but it cannot overwrite the domain.
  async enhancePaymentRequirements(paymentRequirements, supportedKind) {
    return {
      ...paymentRequirements,
      extra: { ...(supportedKind?.extra || {}), ...(paymentRequirements.extra || {}) },
    };
  }
}

// One scheme registration per configured network, for the middleware's `schemes` argument.
export function buildSchemes() {
  return config.networks.map((net) => ({ network: net.network, server: new ExactEvmServerScheme() }));
}

// Facilitator clients, one per rail. The SDK picks the one whose supported networks match the payer's.
//   · X Layer goes through OKXFacilitatorClient, which does the OKX HMAC signing itself — this is the
//     part the listing review is actually looking for. `syncSettle` keeps our existing behaviour of
//     waiting for on-chain confirmation instead of returning `pending`.
//   · Base goes through the generic HTTPFacilitatorClient. Its `createAuthHeaders` hook has exactly the
//     `{verify, settle, supported}` shape that @coinbase/x402 already returns, so the CDP rail needs an
//     adapter and not a rewrite. `supported` is filled from the verify headers because CDP's helper
//     predates that third key; sending the verify credentials there is correct, not a placeholder.
export function buildFacilitators() {
  const clients = [];
  for (const net of config.networks) {
    if (net.facilitatorAuth === 'okx') {
      clients.push(new OKXFacilitatorClient({
        apiKey: config.okxApiKey,
        secretKey: config.okxSecretKey,
        passphrase: config.okxPassphrase,
        // ORIGIN ONLY. The SDK appends its own `/api/v6/pay/x402/...` to this, so passing
        // `config.networks[].facilitatorBase` (which already carries that path) builds
        // `https://web3.okx.com/api/v6/pay/x402/api/v6/pay/x402/supported` and earns a 403 that reads
        // exactly like a credentials problem. It is not: the keys are fine, the URL was doubled.
        baseUrl: config.okxApiBase,
        syncSettle: true,
      }));
    } else if (net.facilitatorAuth === 'cdp') {
      clients.push(new HTTPFacilitatorClient({
        url: net.facilitatorBase,
        createAuthHeaders: async () => {
          const { facilitator } = await import('@coinbase/x402');
          const all = await facilitator.createAuthHeaders();
          return { verify: all.verify, settle: all.settle, supported: all.supported || all.verify };
        },
      }));
    } else {
      clients.push(new HTTPFacilitatorClient({ url: net.facilitatorBase }));
    }
  }
  return clients;
}

// Route table for the SDK middleware: one entry per paid service, both verbs.
//
// Both GET and POST are registered deliberately. The x402 contract this service holds itself to is that
// an unpaid probe of ANY method gets the mandatory 402 challenge and never a 404 or a 400 — that is
// exactly what `onchainos agent x402-check` probes, and what several other ASPs in the cohort fail.
export function buildRoutes(services) {
  const routes = {};
  for (const s of services) {
    // Field names come from the service registry in src/services.js (`price`, `blurb`), not from the
    // argument names `paid()` happens to use. Reading `s.priceUsdt` here silently yields undefined and
    // prices every route at nothing, which is the kind of defect that only shows up at settlement.
    if (s.price === undefined || s.price === null) throw new Error(`service ${s.path} has no price`);
    const cfg = {
      accepts: acceptsFor(s.price),
      resource: s.path,
      description: s.blurb,
      mimeType: 'application/json',
    };
    cfg.unpaidResponseBody = mirrorBody(cfg); // put the challenge in the body too, not only the header
    routes[`GET ${s.path}`] = cfg;
    routes[`POST ${s.path}`] = cfg;
  }
  return routes;
}

// The challenge, in the wire shape, derived from the PaymentOption list a route was configured with.
// One function so the header the SDK writes, the body we mirror it into, and the fallback below can
// never disagree about what this endpoint costs.
function challengePayload(route, resourceUrl, note) {
  return {
    x402Version: 2,
    error: note,
    resource: { url: resourceUrl, description: route.description, mimeType: 'application/json' },
    accepts: route.accepts.map((o) => ({
      scheme: o.scheme,
      network: o.network,
      asset: o.price.asset,
      amount: o.price.amount,
      payTo: o.payTo,
      maxTimeoutSeconds: o.maxTimeoutSeconds,
      extra: o.extra,
    })),
  };
}

// The SDK answers an unpaid request with the challenge in the PAYMENT-REQUIRED header and a body of
// `{}`. That is legal, and it is not what this service shipped: the previous implementation mirrored
// the whole challenge into the body, the docs say so, and buyers in this cohort demonstrably read the
// body — an empty `accepts` there is the single most common way an ASP in the OKX feed turns out to be
// unpayable. Restoring the mirror costs nothing and removes a class of buyer failure.
//
// This was caught only because the gate read the BODY while the first probe read the HEADER, and they
// disagreed. Two instruments looking at the same claim from different sides is what made it visible.
function mirrorBody(route) {
  return (context) => ({
    contentType: 'application/json',
    body: challengePayload(route, context?.adapter?.getUrl?.() || route.resource, 'Payment required'),
  });
}

// The 402 this service falls back to when the SDK is not initialised. Same payload builder, so a client
// cannot tell the two paths apart and neither can drift from the other.
function fallbackChallenge(res, route, resourceUrl, note) {
  const payload = challengePayload(route, resourceUrl, note);
  res.set('PAYMENT-REQUIRED', b64(payload));
  return res.status(402).json(payload);
}

// The payment gate, mounted once for every paid route.
//
// TWO failures shaped this, both found by probing the running service rather than by reading the docs:
//
// 1. `syncFacilitatorOnStart` cannot simply be turned off. The start-up sync is what fetches each
//    facilitator's supported kinds, and without it the middleware answers 402 with an EMPTY `accepts[]`
//    — a challenge nobody can pay, and the exact defect that makes other ASPs in this cohort unusable.
//
// 2. But leaving the SDK to do that sync itself makes the facilitator a HARD dependency of boot: when
//    `getSupported` fails, every paid route answers **HTTP 500**. That is strictly worse than what this
//    service did before the migration, it breaks the one contract x402 actually mandates (an unpaid
//    request gets a 402, never an error), and it would be grounds for a second delisting. A key
//    rotation or a minute of OKX downtime should not take the whole surface off the air.
//
// So initialisation is owned here: retried with backoff, and until it succeeds the gate serves its own
// correctly-shaped 402 instead of a 500. That fallback is deliberately challenge-ONLY — it never
// verifies and never serves the resource — because if we cannot reach a facilitator we cannot confirm
// anyone paid, and the safe direction is to keep asking rather than to give the answer away.
export function paymentGate(services) {
  const routes = buildRoutes(services);
  const server = new x402ResourceServer(buildFacilitators());
  for (const { network, server: scheme } of buildSchemes()) server.register(network, scheme);

  // `false` for the 5th argument: the SDK must not race us to initialize(), because we own the retry.
  const sdk = paymentMiddleware(routes, server, undefined, undefined, false);

  // Readiness is checked PER NETWORK, not taken from initialize()'s own verdict.
  //
  // `initialize()` resolves successfully as long as ANY facilitator answered. The first run of this
  // migration hit exactly that: the OKX facilitator returned 403, Base answered, and init logged
  // `ok:true` while every X Layer request 500'd. An initialiser that reports success when the primary
  // rail is dead is a check that cannot fail, so it is not the one we trust. The gate is ready only
  // when every configured network has a supported kind the SDK can actually build a challenge from.
  const missingKinds = () => config.networks
    .filter((n) => !server.getSupportedKind(2, n.network, 'exact'))
    .map((n) => n.network);

  let ready = false;
  let attempts = 0;
  const init = async () => {
    try {
      await server.initialize();
      const missing = missingKinds();
      if (missing.length) throw new Error(`no supported kind for ${missing.join(', ')}`);
      ready = true;
      console.log(JSON.stringify({ evt: 'x402_init', ok: true, attempts, networks: config.networks.map((n) => n.network) }));
    } catch (e) {
      attempts += 1;
      console.log(JSON.stringify({ evt: 'x402_init', ok: false, attempts, error: String(e?.message || e).slice(0, 200) }));
      const delay = Math.min(60000, 2000 * 2 ** Math.min(attempts, 5));
      setTimeout(init, delay).unref();
    }
  };
  init();

  const gate = (req, res, next) => {
    if (ready) return sdk(req, res, next);
    const key = `${req.method.toUpperCase()} ${req.path}`;
    const route = routes[key];
    if (!route) return next(); // not one of ours; let the 404 handler answer
    const resourceUrl = `${req.protocol}://${req.get('host')}${req.originalUrl.split('?')[0]}`;
    return fallbackChallenge(res, route, resourceUrl, 'Payment required (facilitator handshake pending — retry shortly)');
  };
  gate.isReady = () => ready;
  return gate;
}

// Recurrence instrumentation, moved out of the settle path and onto the receipt the SDK writes.
//
// This has to key off SETTLEMENT and nothing earlier. The BUG-011 postmortem above is the reason: seven
// answers were served against settlements that never landed, and because the counter fired on the
// attempt rather than the receipt, they were about to be reported as traction. The SDK sets
// PAYMENT-RESPONSE only after a settlement it accepted, so reading that header at response time is the
// one signal that cannot count an unsettled call. Wrapping `res.end` is how we observe it without
// taking the settle decision back off the SDK.
export function recurrenceProbe() {
  return (req, res, next) => {
    const originalEnd = res.end;
    res.end = function patchedEnd(...args) {
      try {
        const receipt = res.getHeader('PAYMENT-RESPONSE');
        if (receipt) {
          const r = unb64(String(receipt));
          if (r && r.success === true && (r.transaction || r.txHash)) {
            recordCall(r.payer, (req.path || '').replace(/^\/api\//, ''));
          }
        }
      } catch { /* instrumentation must never break a paid call */ }
      return originalEnd.apply(this, args);
    };
    next();
  };
}

/**
 * Wrap an async business handler. Payment is enforced by the SDK middleware mounted ahead of this, so
 * all this does now is turn a handler's outcome into the status code the SDK reads to decide whether to
 * settle. The call shape (`paid({...})(handler)`) is deliberately unchanged so the 22 route
 * registrations in app.js did not have to be rewritten alongside the payment layer.
 */
export function paid({ priceUsdt, description, inputSchema }) { // eslint-disable-line no-unused-vars
  return (handler) => async (req, res) => {
    if (config.devMode) {
      // Local development only — the deployed service never sets DEV_MODE.
      return res.status(200).json(await handler(req));
    }

    let result;
    try {
      result = await handler(req);
    } catch (e) {
      // Respect an explicit status set by the handler: a business-input rejection carries status 400
      // (`bad_input`) and must not masquerade as a server fault (500) that trips buyer monitoring.
      const status = Number.isInteger(e?.status) ? e.status : 500;
      const code = status >= 400 && status < 500 ? 'bad_input' : 'engine_error';
      // …and it carries the corrected body with it. See refusalBody above for why this line existed
      // in its shorter form for so long, and what a paying caller was getting instead.
      return res.status(status).json(refusalBody(e, status, code));
    }

    // Not a delivered result — the status code is what stops the SDK from settling. See
    // nonChargeableStatus for why these are 400/422 rather than the 200 they used to be.
    if (!isChargeable(result)) {
      // ASCII ONLY, and inside a guard. Both halves of that were learned the expensive way: this line
      // first carried an em dash, Node rejects any non-Latin-1 byte in a header VALUE with
      // ERR_INVALID_CHAR, and the throw landed in an async handler with nothing to catch it — so it
      // killed the process. Every service whose engine refused its own answer took the container down
      // with it and the next two requests got a 502 from the platform edge while it restarted. Seven of
      // twenty-two calls in the first full paid sweep failed that way.
      //
      // The guard is not belt-and-braces for the ASCII fix. It is the actual lesson: an informational
      // header must never be able to fail a paid call, whatever ends up in it later.
      try { res.set('X-QUIVER-NOT-CHARGED', 'engine refused its own answer; no settlement'); }
      catch { /* a header we could not set is not a reason to lose the answer */ }
      return res.status(nonChargeableStatus(result)).json(result);
    }

    return res.status(200).json(result);
  };
}

// Gated diagnostic, kept from the previous implementation because /diag/cdp depends on it: probe the
// Base facilitator's /verify with a synthetic payload to certify the requirements shape without a real
// payer. Read-only — /verify never moves funds.
export async function _probeCdpVerify(paymentPayload) {
  const net = config.networks.find((n) => n.facilitatorAuth === 'cdp');
  if (!net) return { error: 'no CDP network active' };
  const extra = { name: net.eip712Name, version: net.eip712Version, decimals: net.assetDecimals };
  const requirements = {
    scheme: 'exact',
    network: net.network,
    asset: net.asset,
    amount: atomicAmount('0.01', net.assetDecimals),
    payTo: net.payTo,
    maxTimeoutSeconds: config.maxTimeoutSeconds,
    extra,
  };
  const { facilitator } = await import('@coinbase/x402');
  const headers = await facilitator.createAuthHeaders();
  const res = await fetch(`${net.facilitatorBase}/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers.verify },
    body: JSON.stringify({ x402Version: 2, paymentPayload: { ...paymentPayload, accepted: requirements }, paymentRequirements: requirements }),
    signal: AbortSignal.timeout(20000),
  });
  const json = await res.json().catch(() => ({}));
  return { httpStatus: res.status, cdpResponse: json, requirementsSent: requirements };
}

export { b64, unb64 };
