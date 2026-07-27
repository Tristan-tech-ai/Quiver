import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from './config.js';
import { paid } from './x402.js';
import { rateLimit, cached } from './util/guard.js';
import { getCard } from './util/cardstore.js';
import { SERVICES, byName, refusalDetail, inputHint } from './services.js';
import { handleRpc } from './mcp.js';
import { recurrenceSummary } from './recurrence.js';
import { _internal, engineSourceFiles } from './engine/proof.js';

// The same directory buildId() hashes, resolved the same way, so /build cannot describe a rule over
// one tree while the hash was taken over another.
const ENGINE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'engine');

// Technical documentation, served as a plain HTML page so it is readable by both humans and automated
// (LLM) reviewers — a Drive PDF link is not fetchable by an AI screener; this URL is.
const __dir = dirname(fileURLToPath(import.meta.url));
let WHITEPAPER = '';
try { WHITEPAPER = readFileSync(join(__dir, '../assets/whitepaper.html'), 'utf8'); } catch { WHITEPAPER = ''; }
// The machine-readable edition served at /paper — see the route below for why it is the default, and
// why it is served in parts rather than whole.
let PAPER_MD = '';
try { PAPER_MD = readFileSync(join(__dir, '../assets/whitepaper.md'), 'utf8'); } catch { PAPER_MD = ''; }
const PAPER_PARTS = [];
for (let i = 1; i <= 40; i++) {
  try { PAPER_PARTS.push(readFileSync(join(__dir, `../assets/whitepaper.part${i}.md`), 'utf8')); } catch { break; }
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '16kb' }));

app.use((req, res, next) => {
  if (!rateLimit(req.ip || 'unknown', { perMinute: 60 })) return res.status(429).json({ error: 'rate_limited', note: 'max 60 requests/min per IP' });
  next();
});

// Machine-facing self-description: binds this domain to the ERC-8004 identity and advertises EVERY payment
// rail (an automated screener must be able to link service ↔ agent #5152 ↔ payTo without leaving the domain).
const IDENTITY = () => ({
  erc8004AgentId: 5152,
  registryChain: 'eip155:196',
  owner: '0x65bb932d9987f1d1a98b8942a3fa98cb28ec073b',
  proofSigner: _internal.signerAddress(),
});
const PAYMENT = () => ({
  protocol: 'x402 v2',
  scheme: 'exact',
  rails: config.networks.map((n) => ({ network: n.network, asset: n.asset, decimals: n.assetDecimals, payTo: n.payTo })),
  // legacy flat fields (primary rail) kept for existing consumers
  network: config.network,
  asset: 'USDT (X Layer)',
});
app.get('/', (_req, res) => res.json({
  name: 'Quiver',
  tagline: 'A quiver of agent tools — one call.',
  identity: IDENTITY(),
  services: Object.fromEntries(SERVICES.filter((s) => s.register !== false).map((s) => [`POST ${s.path}`, `${s.blurb} — ${s.price} USDT/call`])),
  payment: PAYMENT(),
  mcp: 'POST /mcp — Streamable HTTP MCP endpoint; add this URL to any MCP client (Claude/Cursor/LangChain) to call the verifiable risk brain (free, fair-use daily quota)',
  docs: '/paper',
  docsHuman: '/paper/human',
  build: '/build',
  agentCard: '/.well-known/agent-card.json',
  llms: '/llms.txt',
  repo: 'https://github.com/Tristan-tech-ai/Quiver',
  version: config.version,
}));

// Agent card — the discovery endpoint identity-scanners look for (also aliased at /agent.json).
app.get(['/.well-known/agent-card.json', '/agent.json'], (_req, res) => res.json({
  name: 'Quiver',
  description: 'The verifiable risk brain for autonomous agents — deterministic, proof-carrying risk computation over x402 + MCP.',
  identity: IDENTITY(),
  endpoints: { index: '/', api: '/api/<service>', mcp: '/mcp', docs: '/paper', docsHuman: '/paper/human', build: '/build' },
  payment: PAYMENT(),
  repo: 'https://github.com/Tristan-tech-ai/Quiver',
  version: config.version,
}));

// llms.txt — plain-text summary so LLM/agent crawlers get the essentials without parsing HTML.
app.get('/llms.txt', (_req, res) => {
  const svc = SERVICES.filter((s) => s.register !== false).map((s) => `- POST ${s.path} — ${s.blurb} (${s.price} USDT/call)`).join('\n');
  res.set('content-type', 'text/plain; charset=utf-8').send(`# Quiver — the verifiable risk brain for autonomous agents

Deterministic risk computation where every answer carries a re-runnable, self-checked proof
(echoed inputs + engine codeHash + contentHash + ground-truth self-checks). Re-run the open
engine on the inputs to reproduce the result byte-for-byte: correctness you re-derive, not trust.

Identity: ERC-8004 agent #5152 on X Layer (eip155:196), owner 0x65bb932d9987f1d1a98b8942a3fa98cb28ec073b
Payment: x402 v2 exact — USD₮0 on X Layer (eip155:196) and USDC on Base (eip155:8453); unpaid requests get the 402 challenge with both rails
Free tier: POST /mcp (Streamable HTTP MCP, 9 risk tools, fair-use daily quota)
Docs: /paper (technical documentation, machine-readable and unabridged) · /paper/human (typeset, with figures) · /build (reproducibility provenance) · https://github.com/Tristan-tech-ai/Quiver

## Paid services (x402)
${svc}
`);
});
app.get('/healthz', (_req, res) => res.json({ ok: true, version: config.version, services: SERVICES.filter((s) => s.register !== false).length }));

// Build provenance — makes "re-run bit-for-bit" CHECKABLE, not a promise. `codeHash` is the sha256 of the
// open-source engine sources and equals `proof.codeHash` on every answer; rebuild from the published repo to
// get the identical codeHash, then re-run any engine on `proof.inputs` on the SAME Node/V8 (shown here) to
// reproduce the result bit-for-bit. (Basic IEEE-754 ops are deterministic across platforms; transcendentals
// are stable within a V8 version — pin to this runtime for an exact re-run.)
// Publishing the hash without the RULE that produced it is a trap we walked into ourselves: the walk
// over the engine sources changed from flat to recursive, and every verifier holding its own copy of
// the old rule — our release gate, our published REPRODUCIBLE.md — silently went stale and began
// accusing a correct build. A reader cannot tell "the code changed" from "my recipe is out of date"
// unless the rule travels with the hash. So it does now: the exact walk, the key format, the join, the
// digest, and the file count and manifest the current hash was taken over. A verifier that reproduces
// `files` but not `codeHash` knows the sources moved; one that reproduces neither knows its rule is old.
app.get('/build', (_req, res) => {
  const files = engineSourceFiles(ENGINE_DIR);
  res.json({
    codeHash: _internal.buildId(),
    node: process.version,
    version: config.version,
    repo: 'https://github.com/Tristan-tech-ai/Quiver',
    hashRule: {
      root: 'src/engine',
      select: 'every *.js under the root, RECURSIVELY (subdirectories included)',
      key: 'path relative to the root, forward slashes, sorted ascending by that key',
      entry: '`${relativePath}:${utf8FileContents}`',
      join: '"\\n"',
      digest: "'q1-' + sha256(joined).hex.slice(0, 16)",
      fileCount: files.length,
      files,
      note: 'If your recomputation matches this file list but not the codeHash, the sources changed. If it does not match the file list, your recipe is out of date — this object is the current one.',
    },
    reproduce: 'Rebuild from source → identical codeHash. Then re-run the open engine on proof.inputs (on this Node version) → identical result & contentHash. Correctness is re-derived, not trusted.',
  });
});

// ── Remote MCP endpoint (Streamable HTTP transport) ─────────────────────────────────────────────────────
// The Phase-1 distribution unlock: any MCP-compatible agent (Claude, Cursor, LangChain/CrewAI/OpenAI via an
// MCP client) adds Quiver by URL — `<this-host>/mcp` — and calls the verifiable risk brain directly. Stateless
// request/response (no sessions, no SSE): POST a JSON-RPC message → get the JSON-RPC response. Free T0 (every
// answer still carries its re-runnable, self-checked proof); paid live-data + T1 attestation stay on the x402
// routes. CORS-open: a public read-only compute API with no local resources to protect.
const MCP_CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type, accept, mcp-protocol-version, mcp-session-id, authorization', 'Access-Control-Max-Age': '86400' };
app.options('/mcp', (_req, res) => res.set(MCP_CORS).status(204).end());
app.get('/mcp', (_req, res) => res.set(MCP_CORS).set('Allow', 'POST').status(405).json({ error: 'Stateless MCP endpoint — POST a JSON-RPC message. No SSE stream is offered here.' }));
// Free-tier metering: a generous daily per-IP quota on tool CALLS only (initialize/tools-list stay unmetered),
// with the paid x402 routes offered in-band as the overflow path — the free tier stays a wedge, not an open tap.
const MCP_DAILY_CALLS = Number(process.env.MCP_DAILY_CALLS || 300);
const mcpQuota = new Map(); // ip -> { day, count }
function mcpCallAllowed(ip) {
  const day = new Date().toISOString().slice(0, 10);
  let q = mcpQuota.get(ip);
  if (!q || q.day !== day) {
    if (mcpQuota.size > 50000) mcpQuota.clear(); // unbounded-map guard
    q = { day, count: 0 };
    mcpQuota.set(ip, q);
  }
  q.count += 1;
  return q.count <= MCP_DAILY_CALLS;
}

app.post('/mcp', async (req, res) => {
  res.set(MCP_CORS);
  const msg = req.body;
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'expected a single JSON-RPC message object' } });
  if (msg.method === 'tools/call' && !mcpCallAllowed(req.ip || 'unknown')) {
    return res.status(200).json({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32000, message: `free-tier daily quota reached (${MCP_DAILY_CALLS} tool calls/day/IP). The same engines run pay-per-call over x402 at POST /api/<service> (0.005-0.05 per call, X Layer USDT0 or Base USDC) — an unpaid request returns the 402 challenge with both rails.` } });
  }
  if (msg.id === undefined) { try { await handleRpc(msg); } catch { /* notifications never error back */ } return res.status(202).end(); }
  try {
    const resp = await handleRpc(msg);
    return res.set('Content-Type', 'application/json').json(resp ?? { jsonrpc: '2.0', id: msg.id, result: {} });
  } catch (e) {
    return res.status(500).json({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(e.message || e) } });
  }
});

// Public technical documentation, in two editions.
//
// `/paper` serves the MACHINE-READABLE edition, because the styled one does not survive the trip. An
// AI reader fetching a URL has a bounded character budget, and more than half of the HTML edition is
// markup — span wrappers, table scaffolding, inline SVG path geometry — so the fetch truncated partway
// through and the reader formed its view of Quiver from the opening third of the argument. Measured,
// not assumed: a reviewer hit exactly that. The failure is the same shape as a stale hash — the
// artifact is correct and the consumer is still misinformed — so it is fixed the same way, by serving
// the form the consumer can actually finish. Nothing is abridged: same sections, tables, code blocks
// and all 73 references, generated from the HTML by tools/paper-to-text.mjs.
//
// The typeset edition keeps its figures and moves to `/paper/human`.
app.get(['/paper/human', '/whitepaper', '/docs'], (_req, res) => {
  if (!WHITEPAPER) return res.status(404).json({ error: 'paper_unavailable' });
  res.set('content-type', 'text/html; charset=utf-8');
  res.set('cache-control', 'public, max-age=3600');
  res.send(WHITEPAPER);
});

// Dropping the markup was necessary and not sufficient. Fetched live, an AI reader still stopped
// mid-sentence in 5.19 — about 40% in — and reported the References and all three appendices as
// missing. The budget belongs to the reader, so the document has to ARRIVE in pieces that fit.
// `/paper` is therefore part 1 of 6, and every part opens with the map of all six, which means a
// reader whose fetch truncates anywhere already holds the URLs for the rest.
const md = (res, body, extra = {}) => {
  res.set('content-type', 'text/markdown; charset=utf-8');
  res.set('cache-control', 'public, max-age=3600');
  res.set({ 'x-paper-human-edition': '/paper/human', 'x-paper-parts': String(PAPER_PARTS.length), ...extra });
  res.send(body);
};

app.get(['/paper/full', '/paper.md'], (_req, res) => {
  if (!PAPER_MD) {
    if (WHITEPAPER) return res.set('content-type', 'text/html; charset=utf-8').send(WHITEPAPER);
    return res.status(404).json({ error: 'paper_unavailable' });
  }
  md(res, PAPER_MD);
});

app.get('/paper', (_req, res) => {
  if (PAPER_PARTS.length) return md(res, PAPER_PARTS[0], { 'x-paper-part': '1' });
  // Never 404 the canonical documentation URL over a missing build artifact: fall back to whatever
  // edition does exist rather than telling a reader the paper is unavailable when it is not.
  if (PAPER_MD) return md(res, PAPER_MD);
  if (WHITEPAPER) return res.set('content-type', 'text/html; charset=utf-8').send(WHITEPAPER);
  return res.status(404).json({ error: 'paper_unavailable' });
});

app.get('/paper/:n', (req, res) => {
  const n = Number(req.params.n);
  if (!Number.isInteger(n) || n < 1 || n > PAPER_PARTS.length) {
    return res.status(404).json({
      error: 'no_such_part',
      note: `the documentation is served in ${PAPER_PARTS.length} parts, /paper/1 … /paper/${PAPER_PARTS.length}`,
      whole: '/paper/full', typeset: '/paper/human',
    });
  }
  md(res, PAPER_PARTS[n - 1], { 'x-paper-part': String(n) });
});

// Public artifact serving for rendered cards (already paid for at generation time).
app.get('/card/:id', (req, res) => {
  const id = String(req.params.id).replace(/\.(png|svg)$/, '');
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
  if (v.error) return res.status(400).json({ svc: svc.name, error: 'bad_input', note: refusalDetail(svc, v.error) });
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
  if (v.error) return res.status(400).json({ svc: svc.name, error: 'bad_input', note: refusalDetail(svc, v.error) });
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
// Browser-resident agents must be able to READ the 402 challenge — expose the payment headers via CORS
// (a strict CSP page can fetch /api/* but cannot see PAYMENT-REQUIRED unless it is explicitly exposed).
const API_CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type, payment-signature, x-payment', 'Access-Control-Expose-Headers': 'PAYMENT-REQUIRED, PAYMENT-RESPONSE', 'Access-Control-Max-Age': '86400' };
app.use('/api', (req, res, next) => { res.set(API_CORS); if (req.method === 'OPTIONS') return res.status(204).end(); next(); });

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
    if (v.error) { const err = new Error(`bad_input: ${refusalDetail(s, v.error)}`); err.status = 400; throw err; }
    req.input = v;
    const ctx = { host: `${req.protocol}://${req.get('host')}` };
    if (s.cacheKey) return cached(s.cacheKey(req.input), s.cacheTtl || config.cacheTtlMs, () => s.run(req.input, ctx));
    return s.run(req.input, ctx);
  });
  app.get(s.path, handler);   // unpaid GET probe -> 402 (was 404)
  app.post(s.path, handler);  // unpaid/empty POST -> 402 (was 400)
}

// Unknown path -> JSON 404 (never the Express HTML page), so machine callers always get a parseable error.
app.use((req, res) => res.status(404).json({ error: 'not_found', note: `no route ${req.method} ${req.path}`, index: '/', docs: '/paper' }));

// A body the parser cannot read is the CALLER's error, not ours. It used to fall through to the 500
// below and echo the raw V8 parser message, so an unparseable request was reported as a fault inside
// the service — outside the documented status taxonomy, and contradicting the guarantee that an
// unauthenticated route answers with the 402 challenge rather than an error. Express marks these with
// `type: 'entity.parse.failed'`; the oversized-body case gets its own status for the same reason.
app.use((err, req, res, next) => {
  if (err?.type === 'entity.parse.failed') {
    // The refusal on the SCHEMA path teaches the caller what the service is and what it needs. The
    // parse path used to stop at "that was not JSON", which is the less useful half of the same
    // sentence: a caller whose body is malformed usually also does not know the shape it should have
    // had. The route is known here even though the body is not, so the same hint is available and is
    // now given. Documented in Table 9 of the paper, which previously described the self-teaching
    // note as covering both paths when it covered only one.
    const svc = SERVICES.find((s) => s.path === req.path);
    return res.status(400).json({
      error: 'bad_input',
      note: 'Request body is not valid JSON. Send a JSON object with content-type: application/json. Nothing was computed and no payment was attempted.'
        + (svc ? ` ${svc.name}: ${svc.blurb}. It ${inputHint(svc)}` : ''),
      // The raw parser message names the JSON position that failed, which is the one thing the caller
      // cannot work out from its own request. It is kept deliberately, and it is a V8 string: it
      // discloses the runtime's parser, nothing about this service's state or data.
      parserDetail: String(err.message || '').slice(0, 160),
    });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'bad_input', note: 'Request body exceeds the 16kb limit. Nothing was computed and no payment was attempted.' });
  }
  return next(err);
});
app.use((err, _req, res, _next) => res.status(500).json({ error: 'internal', note: String(err?.message || err).slice(0, 200) }));

export default app;
