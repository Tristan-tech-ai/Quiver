// elapsedMs — the field §2.3 of the paper promises on every response, and the one place it can live
// without breaking the promise printed beside it.
//
// THE CLAIM, AND THE MEASUREMENT THAT FOUND IT FALSE. §2.3 says: "Every response carries an
// `elapsedMs` field so a caller can hold the service to its own timing." Measured against the live
// endpoint before this file existed, a `perp_gate` response had no such key, and `elapsedMs` occurred
// zero times in all nine deterministic engines and zero times in `src/app.js`, `src/mcp.js` and
// `src/services.js`. Thirteen observation engines set one INSIDE their own result; the nine services a
// caller most wants to time — the risk gates — offered no way to. That is worse than a stale number:
// the sentence names a field and tells a reader to hold us to account with it, so a judge who follows
// it finds nothing.
//
// ── WHY THIS IS NOT A NEW TOP-LEVEL KEY ──────────────────────────────────────────────────────────
// `proofEnvelope` / `observationEnvelope` hash `{engine, codeHash, [observedAtUtc,] inputs, result}`
// where `result` is the engine's return value, and then attach the envelope as a SIBLING of it. The
// recipe every response publishes in `verifyContentHash` tells the caller to recompute over "this
// response WITHOUT its `proof` key". So a new top-level key sits INSIDE what the caller hashes and
// OUTSIDE what the service hashed: the stored hash would not move, and the published recipe would
// stop reproducing. That is the same defect §11.5 of the paper records finding twice — an envelope
// whose own text says a mismatch means the response was altered, accusing an honest answer — and
// this time it would have landed on all twenty-two services at once, including the worked proof of
// Appendix C that the paper invites a reader to re-derive.
//
// It is not hypothetical. Measured on the live service on 29 July 2026, a `perp_gate` response that
// carries the existing top-level `inputRepairs` sibling ALREADY fails its own published recipe:
// recomputing "response minus `proof`" verbatim gives `968b12e2…` against a published `3dbb480d…`,
// and the two agree only once `inputRepairs` is also removed. That is a pre-existing defect in a
// different field, reported rather than fixed here; what it settles is where this one goes.
//
// ── WHY THE ENVELOPE IS THE RIGHT HOME AND NOT MERELY THE SAFE ONE ───────────────────────────────
// A timing is not an input and is not part of the computation. It is provenance of the call, which is
// exactly what `version`, `codeHash`, `codeHashScope`, `observedAtUtc` and `attestation` already are,
// and they already live in that block for the same reason. Inside the envelope the key is stripped by
// the caller's own recipe, so it is provably outside the preimage rather than accidentally outside
// it: all twenty-four deterministic content hashes and the Appendix C exhibit `8575ce5a…` are
// byte-identical before and after this file, asserted in gates/gateL-elapsed-timing.mjs.
//
// A response with no envelope at all — a `callerMistake` refusal, which computes nothing — has no
// preimage to disturb, so the field goes at the top level there, which is the only non-committed
// place such a response has. An engine that already set its own top-level `elapsedMs` is never
// overwritten: that number is the engine's internal timing and is inside its own content hash.
//
// ── WHY TWO WRAPPERS AND NOT NINETEEN CALL SITES ─────────────────────────────────────────────────
// The same reasoning the enum guard at the foot of services.js records. Three of the four call sites
// that reach an engine go through `SERVICES[].run` — the paid `/api/*` route and both gated diag
// testers — so one wrapper there closes all three. The fourth is `handleRpc` in src/mcp.js, which
// shares neither the validators nor the service objects, so it carries the same stamp explicitly. A
// fix that covered three of four surfaces is the miss this repository has made repeatedly.

/** The envelope a response carries, identified by the field that defines one rather than by name. */
function envelopeOf(response) {
  for (const key of ['proof', 'observation']) {
    const e = response[key];
    if (e && typeof e === 'object' && !Array.isArray(e) && typeof e.contentHash === 'string') return e;
  }
  return null;
}

/**
 * Read `elapsedMs` off a response wherever it legitimately lives. ONE definition, shared by the two
 * surfaces and by the gate, so a checker cannot look somewhere the server never writes and report a
 * pass — the failure mode gate M was written for.
 */
export function elapsedMsOf(response) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return undefined;
  const env = envelopeOf(response);
  const v = env ? env.elapsedMs : response.elapsedMs;
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Attach `elapsedMs` to a response's provenance block, or to the response itself when it has none. */
export function stampElapsedMs(response, ms) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return response;
  const elapsed = Math.max(0, Math.round(Number(ms) || 0));
  const env = envelopeOf(response);
  if (env) env.elapsedMs = elapsed;
  // Never clobber an engine's own top-level figure: it is inside that response's content hash, and
  // overwriting it would move the hash from outside the engine, which is the one thing this file
  // exists to avoid.
  else if (typeof response.elapsedMs !== 'number') response.elapsedMs = elapsed;
  return response;
}

/**
 * Run a service and stamp how long it took.
 *
 * SYNC-PRESERVING ON PURPOSE. Several services are declared synchronously (`run: (i) => proofEnvelope(…)`)
 * and at least one caller depends on it — test/buyerFixes.test.mjs asserts on `svc.run({hours:72})`
 * without awaiting. Forcing everything through an `async` wrapper would have turned that assertion
 * into one against a Promise, which is a behaviour change smuggled in under a timing field. A thenable
 * is stamped on resolve; anything else is stamped and returned exactly as it was.
 */
export function timedRun(fn) {
  const t0 = Date.now();
  const out = fn();
  return out && typeof out.then === 'function'
    ? out.then((v) => stampElapsedMs(v, Date.now() - t0))
    : stampElapsedMs(out, Date.now() - t0);
}
