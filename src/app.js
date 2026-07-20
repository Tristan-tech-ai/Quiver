import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from './config.js';
import { paid } from './x402.js';
import { rateLimit, cached } from './util/guard.js';
import { getCard } from './util/cardstore.js';
import { SERVICES, byName } from './services.js';
import { handleRpc } from './mcp.js';
import { recurrenceSummary } from './recurrence.js';
import { _internal } from './engine/proof.js';

// Technical documentation, served as a plain HTML page so it is readable by both humans and automated
// (LLM) reviewers — a Drive PDF link is not fetchable by an AI screener; this URL is.
const __dir = dirname(fileURLToPath(import.meta.url));
let WHITEPAPER = '';
try { WHITEPAPER = readFileSync(join(__dir, '../assets/whitepaper.html'), 'utf8'); } catch { WHITEPAPER = ''; }

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '16kb' }));

app.use((req, res, next) => {
  if (!rateLimit(req.ip || 'unknown', { perMinute: 60 })) return res.status(429).json({ error: 'rate_limited', note: 'max 60 requests/min per IP' });
  next();
});

app.get('/', (_req, res) => res.json({
  name: 'Quiver',
  tagline: 'A quiver of agent tools — one call.',
  services: Object.fromEntries(SERVICES.filter((s) => s.register !== false).map((s) => [`POST ${s.path}`, `${s.blurb} — ${s.price} USDT/call`])),
  payment: { protocol: 'x402 v2', scheme: 'exact', network: config.network, asset: 'USDT (X Layer)' },
  mcp: 'POST /mcp — Streamable HTTP MCP endpoint; add this URL to any MCP client (Claude/Cursor/LangChain) to call the verifiable risk brain',
  version: config.version,
}));
app.get('/healthz', (_req, res) => res.json({ ok: true, version: config.version, services: SERVICES.filter((s) => s.register !== false).length }));

// Build provenance — makes "re-run bit-for-bit" CHECKABLE, not a promise. `codeHash` is the sha256 of the
// open-source engine sources and equals `proof.codeHash` on every answer; rebuild from the published repo to
// get the identical codeHash, then re-run any engine on `proof.inputs` on the SAME Node/V8 (shown here) to
// reproduce the result bit-for-bit. (Basic IEEE-754 ops are deterministic across platforms; transcendentals
// are stable within a V8 version — pin to this runtime for an exact re-run.)
app.get('/build', (_req, res) => res.json({
  codeHash: _internal.buildId(),
  node: process.version,
  version: config.version,
  repo: 'https://github.com/Tristan-tech-ai/Quiver',
  reproduce: 'Rebuild from source → identical codeHash. Then re-run the open engine on proof.inputs (on this Node version) → identical result & contentHash. Correctness is re-derived, not trusted.',
}));

// ── Remote MCP endpoint (Streamable HTTP transport) ─────────────────────────────────────────────────────
// The Phase-1 distribution unlock: any MCP-compatible agent (Claude, Cursor, LangChain/CrewAI/OpenAI via an
// MCP client) adds Quiver by URL — `<this-host>/mcp` — and calls the verifiable risk brain directly. Stateless
// request/response (no sessions, no SSE): POST a JSON-RPC message → get the JSON-RPC response. Free T0 (every
// answer still carries its re-runnable, self-checked proof); paid live-data + T1 attestation stay on the x402
// routes. CORS-open: a public read-only compute API with no local resources to protect.
const MCP_CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type, accept, mcp-protocol-version, mcp-session-id, authorization', 'Access-Control-Max-Age': '86400' };
app.options('/mcp', (_req, res) => res.set(MCP_CORS).status(204).end());
app.get('/mcp', (_req, res) => res.set(MCP_CORS).set('Allow', 'POST').status(405).json({ error: 'Stateless MCP endpoint — POST a JSON-RPC message. No SSE stream is offered here.' }));
app.post('/mcp', async (req, res) => {
  res.set(MCP_CORS);
  const msg = req.body;
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'expected a single JSON-RPC message object' } });
  if (msg.id === undefined) { try { await handleRpc(msg); } catch { /* notifications never error back */ } return res.status(202).end(); }
  try {
    const resp = await handleRpc(msg);
    return res.set('Content-Type', 'application/json').json(resp ?? { jsonrpc: '2.0', id: msg.id, result: {} });
  } catch (e) {
    return res.status(500).json({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(e.message || e) } });
  }
});

// Public technical documentation (HTML — LLM- and human-readable). Also aliased at /whitepaper and /docs.
app.get(['/paper', '/whitepaper', '/docs'], (_req, res) => {
  if (!WHITEPAPER) return res.status(404).json({ error: 'paper_unavailable' });
  res.set('content-type', 'text/html; charset=utf-8');
  res.set('cache-control', 'public, max-age=3600');
  res.send(WHITEPAPER);
});

// Public artifact serving for rendered cards (already paid for at generation time).
app.get('/card/:id', (req, res) => {
  const id = String(req.params.id).replace(/\.png$/, '');
  const c = getCard(id);
  if (!c) return res.status(404).json({ error: 'card_not_found_or_expired' });
  res.set('content-type', c.contentType);
  res.set('cache-control', 'public, max-age=3600');
  res.send(c.buffer);
});

// ---- diagnostics (gated) ----
function gated(req, res) { return process.env.DIAG_TOKEN && req.query.token === process.env.DIAG_TOKEN ? true : (res.status(404).end(), false); }

app.get('/diag', async (_req, res) => {
  const probe = async (url) => { const t = Date.now(); try { const r = await fetch(url, { signal: AbortSignal.timeout(8000) }); return { url, status: r.status, ms: Date.now() - t }; } catch (e) { return { url, reachable: false, error: (e.cause?.code || e.name), ms: Date.now() - t }; } };
  res.json({ region: process.env.RAILWAY_REGION || 'unknown', adapter: config.adapter, results: await Promise.all([config.okxApiBase, 'https://web3.okx.com'].map(probe)) });
});

// Phase-1 recurrence readout (gated) — distinct paying callers + how many came back (≥2). The real success signal.
app.get('/diag/recurrence', (req, res) => { if (!gated(req, res)) return; res.json(recurrenceSummary()); });

// Run any service unpaid for verification: /diag/scan?svc=tape-pulse&chain=solana&address=...
app.get('/diag/scan', async (req, res) => {
  if (!gated(req, res)) return;
  const svc = byName[req.query.svc] || byName['tape-pulse'];
  const body = { ...req.query };
  if (body.usd) body.usd = Number(body.usd);
  const v = svc.validate(body);
  if (v.error) return res.status(400).json({ svc: svc.name, error: 'bad_input', note: v.error });
  try {
    res.json(await svc.run(v, { host: `${req.protocol}://${req.get('host')}` }));
  } catch (e) {
    res.status(500).json({ svc: svc.name, error: 'engine_error', detail: String(e.message || e).slice(0, 400) });
  }
});

// POST variant of /diag/scan — for services whose input includes objects (e.g. EIP-712 typedData) that
// don't fit in a query string. Body: { svc, body }. Gated, unpaid, engine-only (same as /diag/scan).
app.post('/diag/scanpost', async (req, res) => {
  if (!gated(req, res)) return;
  const svc = byName[req.body?.svc];
  if (!svc) return res.status(400).json({ error: 'unknown svc' });
  const v = svc.validate(req.body?.body || {});
  if (v.error) return res.status(400).json({ svc: svc.name, error: 'bad_input', note: v.error });
  try { res.json(await svc.run(v, { host: `${req.protocol}://${req.get('host')}` })); }
  catch (e) { res.status(500).json({ svc: svc.name, error: 'engine_error', detail: String(e.message || e).slice(0, 400) }); }
});

// CDP facilitator auth probe (gated, read-only) — certifies the CDP keys + JWT auth + URL + network naming
// WITHOUT a payer: mint a real per-request JWT from the configured CDP creds and GET the facilitator's
// /supported endpoint. 200 => auth accepted; 401 => bad/absent keys; 403 => insufficient scope.
app.get('/diag/cdp', async (req, res) => {
  if (!gated(req, res)) return;
  try {
    if (req.query.verify) {
      // Probe CDP /verify with a synthetic (invalid) eip155:8453 payload against the LIVE Base requirements.
      const dummy = { x402Version: 2, scheme: 'exact', network: 'eip155:8453', payload: { signature: '0x' + '00'.repeat(65), authorization: { from: '0x0000000000000000000000000000000000000001', to: '0x65bb932d9987f1d1a98b8942a3fa98cb28ec073b', value: '10000', validAfter: '0', validBefore: '9999999999', nonce: '0x' + '00'.repeat(32) } } };
      const { _probeCdpVerify } = await import('./x402.js');
      return res.json(await _probeCdpVerify(dummy));
    }
    const { facilitator } = await import('@coinbase/x402');
    const all = await facilitator.createAuthHeaders();
    const hdr = all.supported || {};
    const t = Date.now();
    const r = await fetch(facilitator.url + '/supported', { headers: hdr, signal: AbortSignal.timeout(15000) });
    const text = await r.text();
    let body; try { body = JSON.parse(text); } catch { body = text.slice(0, 300); }
    res.json({ url: facilitator.url + '/supported', status: r.status, ms: Date.now() - t, authPresent: !!hdr.Authorization, body });
  } catch (e) {
    res.status(500).json({ error: 'cdp_probe_failed', detail: String(e.message || e).slice(0, 300) });
  }
});

app.get('/diag/fetch', async (req, res) => {
  if (!gated(req, res)) return;
  const url = req.query.url;
  if (!url || !/^https?:\/\//.test(url)) return res.status(400).json({ error: 'pass ?url=' });
  const t = Date.now();
  try { const r = await fetch(url, { headers: { 'user-agent': 'okxai-asp/1.0', accept: 'application/json' }, signal: AbortSignal.timeout(15000) }); res.json({ url, status: r.status, ms: Date.now() - t, ct: r.headers.get('content-type'), body: (await r.text()).slice(0, 1400) }); }
  catch (e) { res.json({ url, reachable: false, ms: Date.now() - t, error: (e.cause?.code || e.name || String(e.message)).slice(0, 80) }); }
});

// JSON-summarizing probe: fetch a URL, parse, return keys + first array item (no truncation of shape).
// ?url=...&pick=data  -> navigate into a field before summarizing. Gated.
app.get('/diag/j', async (req, res) => {
  if (!gated(req, res)) return;
  const url = req.query.url;
  if (!url || !/^https?:\/\//.test(url)) return res.status(400).json({ error: 'pass ?url=' });
  const t = Date.now();
  try {
    const r = await fetch(url, { headers: { 'user-agent': 'okxai-asp/1.0', accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    let j = await r.json();
    if (req.query.pick) for (const k of String(req.query.pick).split('.')) j = j?.[k];
    const summarize = (v) => {
      if (Array.isArray(v)) return { type: 'array', length: v.length, first: v[0] ?? null, last: v[v.length - 1] ?? null };
      if (v && typeof v === 'object') return { type: 'object', keys: Object.keys(v), sample: v };
      return { type: typeof v, value: v };
    };
    res.json({ url, status: r.status, ms: Date.now() - t, ...summarize(j) });
  } catch (e) { res.json({ url, error: (e.cause?.code || e.name || String(e.message)).slice(0, 120) }); }
});

// Filesystem + chromium diagnostic (gated) — confirm what's actually deployed.
app.get('/diag/ls', async (req, res) => {
  if (!gated(req, res)) return;
  const fsm = await import('node:fs');
  const cp = await import('node:child_process');
  const out = {};
  try { out.chartDir = fsm.readdirSync('src/engine/chart'); } catch (e) { out.chartDir = 'ERR ' + e.message; }
  try { out.playwrightCore = fsm.existsSync('node_modules/playwright-core'); } catch { out.playwrightCore = 'err'; }
  try { out.klinecharts = fsm.existsSync('node_modules/klinecharts/dist/umd/klinecharts.min.js'); } catch { out.klinecharts = 'err'; }
  for (const bin of ['chromium', 'chromium-browser', 'google-chrome']) { try { out[bin] = cp.execSync(`command -v ${bin}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || 'not-found'; } catch { out[bin] = 'not-found'; } }
  try { out.usrBinChromium = fsm.existsSync('/usr/bin/chromium'); } catch { out.usrBinChromium = 'err'; }
  res.json(out);
});

// JSON-RPC probe: POST a method to a given RPC url (for testing simulation support). Gated.
app.get('/diag/rpc', async (req, res) => {
  if (!gated(req, res)) return;
  const url = req.query.url, method = req.query.method;
  if (!url || !method) return res.status(400).json({ error: 'pass ?url=&method=&params=' });
  const t = Date.now();
  try {
    const params = req.query.params ? JSON.parse(req.query.params) : [];
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15000) });
    res.json({ url, method, status: r.status, ms: Date.now() - t, body: (await r.text()).slice(0, 1500) });
  } catch (e) { res.json({ url, method, error: (e.cause?.code || e.name || String(e.message)).slice(0, 100) }); }
});

app.get('/diag/rest', async (req, res) => {
  if (!gated(req, res)) return;
  const path = req.query.path;
  if (!path || !path.startsWith('/')) return res.status(400).json({ error: 'pass ?path=/api/...' });
  try {
    const { okxGet, okxPost } = await import('./okxsign.js');
    const out = req.query.method === 'post' ? await okxPost(path, req.query.body ? JSON.parse(req.query.body) : {}, { timeoutMs: 15000 }) : await okxGet(path, { timeoutMs: 15000 });
    res.json({ path, method: req.query.method || 'get', status: out.status, keyed: !!config.okxApiKey, body: JSON.stringify(out.json).slice(0, 1600) });
  } catch (e) { res.status(200).json({ path, error: (e.cause?.code || e.name || String(e.message)).slice(0, 120) }); }
});

// ---- paid service routes (from the registry) ----
// x402 CONTRACT: the payment gate MUST fire first (before any business-input validation) and on BOTH
// GET and POST, so an unpaid probe of ANY method/body always gets the mandatory HTTP 402 challenge —
// never a 404 (no route) or 400 (bad input). This is exactly what `onchainos agent x402-check` probes.
// Business-input validation runs only AFTER payment is verified, inside the handler.
for (const s of SERVICES) {
  const handler = paid({
    priceUsdt: s.price,
    description: `${s.blurb}`,
    inputSchema: s.inputSchema,
  })(async (req) => {
    const raw = (req.body && Object.keys(req.body).length) ? req.body : (req.query || {});
    const v = s.validate(raw);
    if (v.error) { const err = new Error(`bad_input: ${v.error}`); err.status = 400; throw err; }
    req.input = v;
    const ctx = { host: `${req.protocol}://${req.get('host')}` };
    if (s.cacheKey) return cached(s.cacheKey(req.input), s.cacheTtl || config.cacheTtlMs, () => s.run(req.input, ctx));
    return s.run(req.input, ctx);
  });
  app.get(s.path, handler);   // unpaid GET probe -> 402 (was 404)
  app.post(s.path, handler);  // unpaid/empty POST -> 402 (was 400)
}

app.use((err, _req, res, _next) => res.status(500).json({ error: 'internal', note: String(err?.message || err).slice(0, 200) }));

export default app;
