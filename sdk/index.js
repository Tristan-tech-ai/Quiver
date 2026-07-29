// Quiver Risk Brain — SDK. One import, every deterministic risk computation, each proof-carrying, plus the
// two verification primitives that make the proofs worth something: verify() (recompute the content hash +
// re-check the self-checks) and reproduce() (re-run the open engine on the echoed inputs and confirm the
// result is identical). This is the "layer many agents call": it runs standalone (local compute, instant,
// free, no keys) or against the hosted x402 endpoints.
//
// Usage:
//   import { createRiskBrain } from 'quiver-risk-brain';
//   const rb = createRiskBrain();                 // local mode
//   const r = await rb.perpGate({ symbol: 'BTC', side: 'long', size: 1, margin: 5000 });
//   rb.verify(r);        // -> { valid, contentHashOk, selfChecksOk }
//   rb.reproduce(r);     // -> { reproduced: true } if re-running the engine matches
import { perpGate } from '../src/engine/perpGate.js';
import { sizeGate } from '../src/engine/sizeGate.js';
import { execVerify } from '../src/engine/execVerify.js';
import { optionsRisk } from '../src/engine/optionsRisk.js';
import { lpRisk } from '../src/engine/lpRisk.js';
import { treasuryRisk } from '../src/engine/treasuryRisk.js';
import { riskAttest, verifyInclusion } from '../src/engine/riskAttest.js';
import { portfolioGate } from '../src/engine/portfolioGate.js';
import { eventVol } from '../src/engine/eventVol.js';
import { proofEnvelope, _internal } from '../src/engine/proof.js';
import { enrichPerpInputs, enrichPortfolioLegs } from '../src/adapters/hyperliquid.js';

// engine dispatch by service name — reproduce() re-runs the exact engine on proof.inputs.
const ENGINES = {
  'perp-gate': perpGate, 'portfolio-gate': portfolioGate, 'size-gate': sizeGate, 'exec-verify': execVerify,
  'options-risk': optionsRisk, 'lp-risk': lpRisk, 'treasury-risk': treasuryRisk, 'risk-attest': riskAttest, 'event-vol': eventVol,
};

export function createRiskBrain({ mode = 'local', baseUrl = 'https://quiver-production-c3a8.up.railway.app', version = 'sdk', fetchImpl } = {}) {
  const V = version;

  const localCompute = {
    async perpGate(a) {
      const e = await enrichPerpInputs(a);
      const { live, ...compute } = e;
      const r = perpGate(compute);
      if (live) r.live = live;
      return proofEnvelope('perp-gate', compute, r, V);
    },
    async portfolioGate(a) { const positions = await enrichPortfolioLegs(a?.positions); const input = { ...a, positions }; return proofEnvelope('portfolio-gate', input, portfolioGate(input), V); },
    sizeGate(a) { return proofEnvelope('size-gate', a, sizeGate(a), V); },
    execVerify(a) { return proofEnvelope('exec-verify', a, execVerify(a), V); },
    optionsRisk(a) { return proofEnvelope('options-risk', a, optionsRisk(a), V); },
    lpRisk(a) { return proofEnvelope('lp-risk', a, lpRisk(a), V); },
    treasuryRisk(a) { return proofEnvelope('treasury-risk', a, treasuryRisk(a), V); },
    eventVol(a) { return proofEnvelope('event-vol', a, eventVol(a), V); },
    attest(a) { return proofEnvelope('risk-attest', a, riskAttest(a), V); },
  };

  // Hosted mode: POST to the x402 endpoint. The endpoints are payment-gated, so the caller must supply a
  // fetchImpl that carries an x402 PAYMENT-SIGNATURE header (this SDK never holds keys). Without one, a 402
  // with the payment requirements is returned to the caller to handle.
  const hosted = {};
  const NAME = { perpGate: 'perp-gate', portfolioGate: 'portfolio-gate', sizeGate: 'size-gate', execVerify: 'exec-verify', optionsRisk: 'options-risk', lpRisk: 'lp-risk', treasuryRisk: 'treasury-risk', eventVol: 'event-vol', attest: 'risk-attest' };
  for (const [m, path] of Object.entries(NAME)) {
    hosted[m] = async (a) => {
      const f = fetchImpl || fetch;
      const res = await f(`${baseUrl}/api/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(a) });
      const json = await res.json().catch(() => ({}));
      if (res.status === 402) return { paymentRequired: true, status: 402, accepts: json.accepts, note: 'endpoint is x402-gated; supply a fetchImpl that adds a PAYMENT-SIGNATURE header' };
      return json;
    };
  }

  // verify(): recompute the content hash from the echoed fields + the (envelope-stripped) result, and
  // re-check that every self-check passed. Cheap; needs no re-run. A tampered result changes the hash and
  // fails here. Handles BOTH envelope kinds: `proof` (deterministic services — also reproduce()-able) and
  // `observation` (live-market services — committed snapshot, timestamped, NOT re-runnable by design).
  // The result is hashed in its WIRE form (one JSON round-trip): res.json drops undefined-valued keys and
  // stringifies Dates, and the server commits to exactly that form — so verify() matches both a response
  // received over HTTP (round-trip is a no-op) and a locally-computed envelope still holding such values.
  //
  // AND IT STRIPS WHAT THE ENVELOPE SAYS TO STRIP. This function is the executable form of the recipe in
  // `verifyContentHash`, so it inherited that recipe's defect exactly: it removed the envelope key and
  // nothing else, while the host attaches `inputRepairs`, `routingNotice`, `howToFix` and `snark` as
  // top-level siblings AFTER the hash is taken. Measured on the live service on 29 July 2026, a
  // `perp_gate` call with its body wrapped in `params` — what an agent framework does by default — came
  // back with `contentHashOk: false` on an untouched, honest response. The envelope now publishes the
  // exact key names in `excludedFromContentHash`, and this reads them instead of assuming there are none.
  // Absent (a locally built envelope, or a host older than this field) it degrades to the old behaviour,
  // which is correct precisely when nothing was attached.
  function verify(envelope) {
    const p = envelope?.proof, o = envelope?.observation;
    if (!p && !o) return { valid: false, reason: 'no proof or observation envelope' };
    const clean = _internal.jsonClean;
    const env = p || o;
    const kind = p ? 'proof' : 'observation';
    const drop = new Set([kind, ...(Array.isArray(env.excludedFromContentHash) ? env.excludedFromContentHash : [])]);
    const result = {};
    for (const k of Object.keys(envelope)) if (!drop.has(k)) result[k] = envelope[k];
    const recomputed = _internal.sha256(_internal.canonical(p
      ? { engine: p.engine, codeHash: p.codeHash, inputs: p.inputs, result: clean(result) }
      : { engine: o.engine, codeHash: o.codeHash, observedAtUtc: o.observedAtUtc, inputs: o.inputs, result: clean(result) }));
    const contentHashOk = recomputed === env.contentHash;
    const selfChecksOk = (env.selfChecks || []).every((c) => c.pass !== false);
    return { valid: contentHashOk && selfChecksOk, contentHashOk, selfChecksOk, envelopeKind: kind };
  }

  // reproduce(): re-run the open engine on proof.inputs and confirm the (proof-stripped, live-stripped)
  // result is byte-identical. This is the strong guarantee — correctness you re-derive, not signature trust.
  // Observation envelopes are refused honestly: live-market answers cannot be reproduced, only verified.
  function reproduce(envelope) {
    if (envelope?.observation) return { reproduced: false, reason: 'observation envelope: a live-market snapshot is not re-runnable (verify() it instead)' };
    const p = envelope?.proof;
    if (!p || !ENGINES[p.engine]) return { reproduced: false, reason: 'unknown engine or no proof' };
    const fresh = ENGINES[p.engine](p.inputs);
    // strip proof + live (live is non-deterministic provenance) + everything the envelope declares it
    // attached after the hash was taken — the same list verify() reads, for the same reason: a
    // `routingNotice` the host bolted on is no more part of the engine's output than `proof` is.
    const drop = new Set(['proof', 'live', ...(Array.isArray(p.excludedFromContentHash) ? p.excludedFromContentHash : [])]);
    const expected = {};
    for (const k of Object.keys(envelope)) if (!drop.has(k)) expected[k] = envelope[k];
    const a = _internal.canonical(_internal.jsonClean(fresh));
    const b = _internal.canonical(_internal.jsonClean(expected));
    return { reproduced: a === b, engine: p.engine };
  }

  const api = mode === 'hosted' ? hosted : localCompute;
  return { ...api, verify, reproduce, verifyInclusion, mode, tools: Object.keys(NAME) };
}

export { verifyInclusion };
