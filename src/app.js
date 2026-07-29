import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from './config.js';
import { paid } from './x402.js';
import { rateLimit, cached } from './util/guard.js';
import { getCard } from './util/cardstore.js';
import { SERVICES, byName, refusalDetail, inputHint } from './services.js';
import { suggestService, redirectLine } from './util/routing.js';
import { repairBody, correctedExample } from './util/repair.js';
import { sealContentHashRecipe } from './util/recipe.js';
import { handleRpc } from './mcp.js';
import { recurrenceSummary } from './recurrence.js';
import { getProof, verificationKey, warmProver, CIRCUITS } from './util/snark.js';
// Every one of these is async — see util/proofStore.js for why there is no synchronous read left on
// either backend. `kind()` is the exception and does no I/O at all.
import { durable as proofsAreDurable, count as storedProofCount, kind as proofStoreKind, durabilityNote } from './util/proofStore.js';
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
// Human landing page for `/`, served only when the caller asks for HTML — see the index route.
// Dated record of what changed since the submission was written. Judging runs after the deadline,
// so a reviewer needs to be able to tell an improvement from a discrepancy without taking our word
// for which is which.
let CHANGELOG = '';
try { CHANGELOG = readFileSync(join(__dir, '../assets/changelog.md'), 'utf8'); } catch { CHANGELOG = ''; }
let LANDING = '';
try { LANDING = readFileSync(join(__dir, '../assets/landing.html'), 'utf8'); } catch { LANDING = ''; }
const PAPER_PARTS = [];
for (let i = 1; i <= 40; i++) {
  try { PAPER_PARTS.push(readFileSync(join(__dir, `../assets/whitepaper.part${i}.md`), 'utf8')); } catch { break; }
}

warmProver().catch(() => { /* proving is optional; the service must boot without it */ });

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
// The index answers two very different readers, so it answers them differently. An agent — or curl,
// which sends `*/*` — gets the machine service index, unchanged and first, because that is the
// contract anything automated depends on. A browser, which asks for text/html, gets a page: the
// endpoint URL appears in the submission and in the registry entry, and a human who clicks it and
// receives four kilobytes of raw JSON has learned nothing about whether this is a finished product.
// `res.format` keys are ordered deliberately: json first makes it the default for `*/*`.
const INDEX_JSON = () => ({
  name: 'Quiver',
  tagline: 'A quiver of agent tools — one call.',
  identity: IDENTITY(),
  services: Object.fromEntries(SERVICES.filter((s) => s.register !== false).map((s) => [`POST ${s.path}`, `${s.blurb} — ${s.price} USDT/call`])),
  payment: PAYMENT(),
  mcp: 'POST /mcp — Streamable HTTP MCP endpoint; add this URL to any MCP client (Claude/Cursor/LangChain) to call the verifiable risk brain (free, fair-use daily quota)',
  docs: '/paper',
  docsMachineReadable: [...PAPER_PARTS.map((_, i) => `/paper/${i + 1}`), '/paper/full'],
  build: '/build',
  changelog: '/changelog — dated record of what changed since the hackathon submission was written; the endpoint URL and the engine build hash do not move while judging runs',
  agentCard: '/.well-known/agent-card.json',
  llms: '/llms.txt',
  repo: 'https://github.com/Tristan-tech-ai/Quiver',
  version: config.version,
});
app.get('/', (req, res) => {
  res.format({
    json: () => res.json(INDEX_JSON()),
    html: () => {
      if (!LANDING) return res.json(INDEX_JSON());   // never fail the index over a missing asset
      res.set('content-type', 'text/html; charset=utf-8');
      res.set('cache-control', 'public, max-age=600');
      res.send(LANDING);
    },
    default: () => res.json(INDEX_JSON()),
  });
});

// Agent card — the discovery endpoint identity-scanners look for (also aliased at /agent.json).
app.get(['/.well-known/agent-card.json', '/agent.json'], (_req, res) => res.json({
  name: 'Quiver',
  description: 'The verifiable risk brain for autonomous agents — deterministic, proof-carrying risk computation over x402 + MCP.',
  identity: IDENTITY(),
  endpoints: { index: '/', api: '/api/<service>', mcp: '/mcp', docs: '/paper', docsMachineReadable: [...PAPER_PARTS.map((_, i) => `/paper/${i + 1}`), '/paper/full'], build: '/build', proof: '/proof/<contentHash>', verificationKey: '/proof/vk' },
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
Changes since submission: /changelog
Docs: /paper (technical documentation, typeset) · /paper/1../paper/${PAPER_PARTS.length} (same text, plain markdown, AI-readable) · /build (reproducibility provenance) · https://github.com/Tristan-tech-ai/Quiver

## Paid services (x402)
${svc}
`);
});
app.get(['/changelog', '/changes'], (_req, res) => {
  if (!CHANGELOG) return res.status(404).json({ error: 'no_changelog' });
  res.set('content-type', 'text/markdown; charset=utf-8').send(CHANGELOG);
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
// Reported rather than claimed, and never allowed to throw: a store that is down must make /build say
// so, not make /build disappear. The shape is fixed — {durable, kind, stored, note} — and `kind` names
// which of the three backends is live, so a reader can tell an S3 deploy from a disk deploy from a
// memory-only one without inferring it from whether proofs happen to survive.
async function proofStorageReport() {
  try {
    if (await proofsAreDurable()) {
      return {
        durable: true,
        kind: proofStoreKind(),
        stored: await storedProofCount(),
        note: 'A finished proof survives this process and is readable by any replica sharing the store.',
      };
    }
    // The reason travels with the `false`. A configured-but-unreachable bucket reporting a bare
    // `durable: false` would be indistinguishable from a deploy that never turned durability on,
    // which is the exact silent fallback this store was rebuilt to make impossible.
    const why = await durabilityNote();
    return {
      durable: false,
      kind: proofStoreKind(),
      stored: 0,
      note: proofStoreKind() === 'in-memory only'
        ? 'Proofs are held in memory and cleared by a redeploy. Set QUIVER_PROOF_S3_BUCKET (shared by every replica) or QUIVER_PROOF_DIR (this container only) to make them durable.'
        : `Durable storage is CONFIGURED BUT NOT WORKING, so proofs are held in memory and cleared by a redeploy: ${why}`,
    };
  } catch (e) {
    return { durable: false, kind: 'unknown', stored: 0, note: `the proof store could not be inspected: ${String((e && e.message) || e).slice(0, 160)}` };
  }
}

app.get('/build', async (_req, res) => {
  const files = engineSourceFiles(ENGINE_DIR);
  const proofStorage = await proofStorageReport();
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
    // Reported rather than claimed. A reader who wants to know whether a proof they fetched will
    // still be there after a redeploy can read it here instead of taking a docs sentence for it.
    proofStorage,
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

// Succinct-proof retrieval. Free, because a proof of an answer somebody else already paid for costs
// us nothing to hand over, and because a third party checking a number they did not buy is exactly
// the situation this whole envelope exists for.
//
// `/proof/vk` is matched first: a verification key is not a content hash, and letting it fall into
// the parameterised route would answer "no such proof" for the one document a verifier needs most.
app.get('/proof/vk', (_req, res) => {
  const vk = verificationKey();
  if (!vk) return res.status(404).json({ error: 'verification_key_unavailable' });
  res.set('cache-control', 'public, max-age=86400');
  res.json({
    protocol: 'plonk',
    note: 'Verify with: snarkjs plonk verify <this> <publicSignals> <proof>. Plonk rather than Groth16 deliberately — the Groth16 circuit-specific ceremony had a single participant and it was our machine, so a proof under it is forgeable by us. This key derives from the public Hermez powers-of-tau.',
    verificationKey: vk,
  });
});

// A SECOND CIRCUIT NEEDS A SECOND KEY, and this route exists rather than a query parameter on the
// one above because `/proof/vk` is a published URL: the paper quotes it, every liquidation proof
// carries it as a string, and re-pointing it at a key selector would change what an existing caller
// gets back. So `/proof/vk` keeps meaning exactly the liquidation key it has always meant, and each
// further circuit gets its own path. `/proof/:contentHash` matches two path segments and this matches
// three, so the two cannot collide however they are ordered.
//
// An unknown circuit is a 404 that NAMES the ones that exist. Answering "no key" without saying which
// keys there are is the shape of refusal this codebase keeps replacing: a caller holding a proof they
// cannot check has no way to discover the right URL from the wrong one.
app.get('/proof/vk/:circuit', (req, res) => {
  const name = String(req.params.circuit || '').toLowerCase();
  const vk = verificationKey(name);
  if (!vk) {
    return res.status(404).json({
      error: 'verification_key_unavailable',
      circuit: name,
      available: CIRCUITS,
      note: `This host proves ${CIRCUITS.join(' and ')}. Each proof record names its own circuit and carries the URL of the key that checks it; /proof/vk without a circuit is the liquidation key, for the perp-gate proofs that have always been served there.`,
    });
  }
  res.set('cache-control', 'public, max-age=86400');
  res.json({
    protocol: 'plonk',
    circuit: name,
    note: 'Verify with: snarkjs plonk verify <this> <publicSignals> <proof>. Plonk rather than Groth16 deliberately — the Groth16 circuit-specific ceremony had a single participant and it was our machine, so a proof under it is forgeable by us. This key derives from the public Hermez powers-of-tau.',
    verificationKey: vk,
  });
});

// `async` because the store is. A missing `await` on getProof would serialise a Promise as `{}` and
// answer 200 with an empty body — which is why gate A asserts on this route's JSON rather than on the
// store's return value.
app.get('/proof/:contentHash', async (req, res) => {
  const h = String(req.params.contentHash || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(h)) {
    return res.status(400).json({ error: 'bad_content_hash', note: 'Pass the 64-character proof.contentHash from a perp-gate or size-gate response.' });
  }
  const rec = await getProof(h);
  if (!rec) {
    // The note has to say which of the THREE worlds this deploy is in, because "a redeploy clears
    // them" stops being true the moment durable storage is configured, and a stale reassurance in a
    // 404 is exactly the kind of claim this service exists to not make. The third world — configured
    // and broken — is the one that matters most: without it a store that cannot reach its bucket
    // answers exactly like a store nobody turned on, and nothing in the response says otherwise.
    const durable = await proofsAreDurable();
    const why = durable ? null : await durabilityNote();
    return res.status(404).json({
      error: 'no_proof_for_that_hash',
      note: durable
        ? 'A proof is built only when a perp-gate or size-gate call asks for one with {"snark": true}. Finished proofs are stored by content hash and survive a redeploy, so this hash was never proved here; ask again and it will be built.'
        : proofStoreKind() === 'in-memory only'
          ? 'A proof is built only when a perp-gate or size-gate call asks for one with {"snark": true}. Proofs are held in memory, so a redeploy clears them; ask again and it will be rebuilt.'
          : `A proof is built only when a perp-gate or size-gate call asks for one with {"snark": true}. Durable storage is CONFIGURED BUT NOT WORKING here, so this miss may be the store rather than the hash: ${why}`,
    });
  }
  if (rec.status === 'building') return res.status(202).json({ status: 'building', retryAfterMs: 900, contentHash: h });
  if (rec.status !== 'ready') return res.status(409).json({ status: rec.status, error: rec.error || null, contentHash: h });
  // WHICH IDENTITY THIS PROOF IS ABOUT. Absent on every record built before this host knew a second
  // circuit, and absent on every liquidation record built since — the field is written only when the
  // circuit is NOT liquidation, so the default here is what makes the thousands of already-published
  // perp-gate proofs serialise to the byte they always did. gates/gateS-live-input-snark.mjs pins that
  // key list exactly; it is the check that would catch this going wrong.
  const circuit = rec.circuit || 'liquidation';
  const kelly = circuit === 'kelly';
  const hhi = circuit === 'concentration';
  res.json({
    status: 'ready', contentHash: h, protocol: rec.protocol,
    // Spread, so a liquidation response has no `circuit` key at all and its shape is unmoved. A Kelly
    // proof announces itself, because a reader who fetched this hash may never have seen the answer
    // it came from and has no other way to know which key checks it or what the signals mean.
    ...(rec.circuit ? { circuit: rec.circuit } : {}),
    proof: rec.proof, publicSignals: rec.publicSignals,
    encodedInputs: rec.encoded, gapToServedPrice: rec.gapToServedPrice,
    // A bankroll fraction is not a price, and giving it the price's field name would be the schema
    // itself telling a reader something false. Present only on a Kelly record.
    ...(rec.gapToServedFraction !== undefined ? { gapToServedFraction: rec.gapToServedFraction } : {}),
    ...(rec.gapToServedIndex !== undefined ? { gapToServedIndex: rec.gapToServedIndex } : {}),
    ...(hhi ? {
      signalLayout: ['residual', 'tolerance', 'weightSlack', 'wHat[0..7]', 'hHat'],
      proves: 'Ĥ·S = Σ ŵᵢ² over the scaled integers, with the residual R and a one-grid-step tolerance published as signals 0 and 1, and the drift of the shares from summing to the whole book published as signal 2. The proven bound is 2|R| <= S, which says Ĥ is the CORRECTLY ROUNDED Herfindahl index of these shares rather than merely a number near it.',
      doesNotProve: 'That the shares are a real treasury. They are inputs, and the circuit has no term for where a balance came from. It also covers the byAsset dimension alone; the treasury-risk answer this hash came from publishes byVenue and byChain beside it, and neither is here.',
    } : {}),
    ...(kelly ? {
      signalLayout: ['residual', 'tolerance', 'pHat', 'bHat', 'fHat'],
      proves: 'f*·b = p·b + p - 1 over the scaled integers, with the residual R and the tolerance b̂ published as signals 0 and 1 so a verifier sees the slack actually used rather than being asked to trust that it was small. The proven bound is 2|R| <= b̂.',
      doesNotProve: 'That the edge is real, or that the recommendation was this number. The circuit takes p and b as given and has no term for kellyFraction, so signal 4 is the FULL-Kelly ceiling; the size-gate answer this hash came from recommends a fraction of it.',
    } : {}),
    // Two separate claims, and the caller gets both or neither is implied. The proof says the
    // arithmetic is right; the attestation says Quiver stands behind these exact eight field
    // elements. Absent when no signing key is configured — an unattested proof is still a proof,
    // and inventing a signature would be worse than shipping none. This response builds its own
    // key list rather than spreading `rec`, which is how the attestation went missing in production
    // for one deploy: the route was written before the field existed and silently dropped it.
    signalsAttestation: rec.signalsAttestation || null,
    // The key that checks THIS proof, not the key that checks the other one. A single published URL
    // was correct while there was a single circuit and becomes a wrong answer the moment there are
    // two — a verifier handed the liquidation key for a Kelly proof gets a failed verification and no
    // reason for it, which reads exactly like a forged proof.
    verificationKey: rec.circuit ? `/proof/vk/${rec.circuit}` : '/proof/vk', verify: rec.verify,
    // Present only when at least one number in the proven statement was READ FROM A VENUE rather than
    // supplied by the caller — which is a distinction the circuit cannot carry, because it has no term
    // for where a number came from. Spread rather than assigned, and placed immediately above the
    // on-chain instruction on purpose: `onChain` is where a reader forms the belief that this is
    // verifiable end to end, and for a live-read input it is the arithmetic that gets verified there,
    // not the input. Every proof built before this field existed serialises exactly as it did.
    ...(rec.provenance ? { provenance: rec.provenance } : {}),
    // THE SIGNAL COUNT IS PART OF THE ABI AND IT IS NOT THE SAME. The liquidation circuit publishes
    // eight public signals and the Kelly circuit five, so handing a caller `uint256[8]` for a Kelly
    // proof is an instruction that cannot compile — a wrong number dressed as a call signature. The
    // liquidation branch is the string this route has always returned, unchanged.
    onChain: kelly
      ? {
        contract: 'KellyVerifier.verifyProof(uint256[24] proof, uint256[5] publicSignals)',
        note: 'Pass snarkjs plonk.exportSolidityCallData output straight in. The verifier is generated by snarkjs from kelly_plonk.zkey and is NOT deployed — it exists in this repository at zk/build/KellyVerifier.sol, gated by zk/scripts/gateB2-kelly-evm.mjs against a local EVM, and has no address on any chain. This field describes what checks the proof, not something that has happened on chain.',
      }
      : hhi
        ? {
          contract: 'ConcentrationVerifier.verifyProof(uint256[24] proof, uint256[12] publicSignals)',
          note: 'Pass snarkjs plonk.exportSolidityCallData output straight in. The verifier is generated by snarkjs from concentration_plonk.zkey and is NOT deployed — it exists in this repository at zk/build/ConcentrationVerifier.sol, gated by zk/scripts/gateB3-2-concentration-evm.mjs against a local EVM, and has no address on any chain. Twelve signals: three outputs, then eight shares and the index.',
        }
        : {
        contract: 'QuiverProofRegistry.submit(uint256[24] proof, uint256[8] publicSignals, bytes attestation)',
        note: 'Pass snarkjs plonk.exportSolidityCallData output straight in. The contract verifies the arithmetic itself and records the outcome; a bad proof is refused in public rather than reverted silently.',
      },
  });
});

// Public technical documentation. One document, two shapes, and `/paper` keeps its original meaning:
// the typeset edition, for a person.
//
// The machine-readable edition lives beside it at `/paper/1` … `/paper/6`. It exists because the
// styled document does not survive the trip to an AI reader: 395 kB, most of it markup, against a
// bounded fetch budget. Stripping the markup to 236 kB of clean markdown was NOT enough — measured,
// not assumed: a real fetch of that still stopped mid-sentence in §5.19 and reported the References
// and all three appendices as missing. The budget belongs to the reader, so the document has to
// ARRIVE in pieces that fit. Each part opens with the map of all six, so a fetch truncated anywhere
// has already delivered the URLs for the rest. Nothing is abridged; a test asserts the parts
// concatenate to the whole.
//
// `/paper` was briefly the machine edition. That broke every consumer expecting the whole document
// from the canonical URL — including this project's own release gate, which is how the cost showed
// up. Discovery is handled inside the HTML instead, by a banner naming the parts.
const md = (res, body, extra = {}) => {
  res.set('content-type', 'text/markdown; charset=utf-8');
  res.set('cache-control', 'public, max-age=3600');
  res.set({ 'x-paper-parts': String(PAPER_PARTS.length), 'x-paper-machine-edition': '/paper/1', ...extra });
  res.send(body);
};

app.get(['/paper/full', '/paper.md'], (_req, res) => {
  if (!PAPER_MD) {
    if (WHITEPAPER) return res.set('content-type', 'text/html; charset=utf-8').send(WHITEPAPER);
    return res.status(404).json({ error: 'paper_unavailable' });
  }
  md(res, PAPER_MD);
});

app.get('/paper/:n', (req, res) => {
  const n = Number(req.params.n);
  if (!Number.isInteger(n) || n < 1 || n > PAPER_PARTS.length) {
    return res.status(404).json({
      error: 'no_such_part',
      note: `the machine-readable documentation is served in ${PAPER_PARTS.length} parts, /paper/1 … /paper/${PAPER_PARTS.length}`,
      whole: '/paper/full', typeset: '/paper',
    });
  }
  md(res, PAPER_PARTS[n - 1], { 'x-paper-part': String(n) });
});

app.get(['/paper', '/whitepaper', '/docs'], (_req, res) => {
  if (!WHITEPAPER) {
    // Never 404 the canonical documentation URL over a missing build artifact.
    if (PAPER_MD) return md(res, PAPER_MD);
    return res.status(404).json({ error: 'paper_unavailable' });
  }
  res.set('content-type', 'text/html; charset=utf-8');
  res.set('cache-control', 'public, max-age=3600');
  // An automated reader that lands here blind cannot know the machine edition exists, and it will
  // truncate before finding out. Say so in a header, which costs it nothing to read.
  res.set({ 'x-paper-machine-edition': '/paper/1', 'x-paper-parts': String(PAPER_PARTS.length) });
  res.send(WHITEPAPER);
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
  if (v.error) return res.status(400).json({ svc: svc.name, error: 'bad_input', note: refusalDetail(svc, v.error), routingNotice: suggestService(svc, req.body || {}, SERVICES) });
  try {
    // Sealed like the paid path: this tester attaches no sibling of its own, but `snark` is attached
    // INSIDE perp-gate's own handler, so an unsealed response here would publish a recipe that does
    // not reproduce for exactly the call a verifier is most likely to make.
    res.json(sealContentHashRecipe(await svc.run(v, { host: `${req.protocol}://${req.get('host')}` })));
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
  if (v.error) return res.status(400).json({ svc: svc.name, error: 'bad_input', note: refusalDetail(svc, v.error), routingNotice: suggestService(svc, req.body || {}, SERVICES) });
  try { res.json(sealContentHashRecipe(await svc.run(v, { host: `${req.protocol}://${req.get('host')}` }))); }
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
    const sent = (req.body && Object.keys(req.body).length) ? req.body : (req.query || {});

    // Repair the SHAPE before validating, and never the VALUES. An agent that nested its params under
    // `params`, sent 64000 as a string, or wrote `Currency` has said what it meant clearly enough to
    // act on; one that omitted the position size has not. See util/repair.js for the line and why it
    // sits there. Every repair is reported back, because a silent coercion is how a caller gets billed
    // for an answer about something they did not describe.
    const { body: raw, repairs, missing } = repairBody(s, sent);

    const v = s.validate(raw);
    if (v.error) {
      // A refusal that says what THIS service needs is true and was not enough: agent #5152's only two
      // bad reviews came from a caller that read such a hint and still could not find the right shop.
      // So a refusal now carries three things — what went wrong, the exact body that would work, and
      // the service that fits if this is not it.
      const redirect = redirectLine(s, raw, SERVICES);
      const err = new Error(`bad_input: ${refusalDetail(s, v.error)}${redirect ? ` | ${redirect}` : ''}`);
      err.status = 400;
      err.detail = {
        repairsApplied: repairs.length ? repairs : undefined,
        howToFix: correctedExample(s, raw, missing),
        routingNotice: suggestService(s, raw, SERVICES) || undefined,
      };
      throw err;
    }
    req.input = v;
    req.repairs = repairs;
    const ctx = { host: `${req.protocol}://${req.get('host')}` };
    const answer = s.cacheKey
      ? await cached(s.cacheKey(req.input), s.cacheTtl || config.cacheTtlMs, () => s.run(req.input, ctx))
      : await s.run(req.input, ctx);

    // The harder case, and the one that actually cost the two half-stars: the call SUCCEEDED at the
    // wrong shop. Nothing was refused, the numbers are correct, and they answer a question the caller
    // did not ask. Attached as a SIBLING of `result` and `proof`, never inside either, so the content
    // hash covers exactly what it covered before and every published proof keeps reproducing.
    if (repairs.length && answer && typeof answer === 'object') {
      // Reported, never silent. A caller has to be able to see that the body they sent is not quite
      // the body that was priced.
      // The note used to read "Shapes only: no value was supplied, defaulted or guessed." Step 6 of
      // repair.js rewrites a VALUE — `side: "SHORT"` is served as `"short"` — so "shapes only" had
      // stopped being true the moment the enums were declared. The three promises that matter are kept
      // and the claim narrowed to what is actually enforced: every change is a re-reading of the
      // caller's own bytes, and a value matching no declared alternative is passed through untouched.
      answer.inputRepairs = { applied: repairs, note: 'Your request was normalised before pricing. No value was supplied, defaulted or guessed: every change above is a re-reading of what you sent — params lifted out of a wrapper, a key matched to the one this service declares, a written number or boolean read as one, or a value matched case-insensitively to one of the alternatives this service declares for that key. A value matching none of them is passed through exactly as you wrote it.' };
    }
    const misroute = answer && typeof answer === 'object' ? suggestService(s, raw, SERVICES) : null;
    if (misroute) {
      answer.routingNotice = {
        note: `This answer is correct for ${s.name}, but the request looks like it was meant for ${misroute.service}.`,
        because: misroute.because,
        suggested: { service: misroute.service, endpoint: misroute.endpoint, price: misroute.price },
        retry: misroute.retry,
        disclaimer: 'Quiver does not reroute a paid call. You asked this endpoint and this endpoint answered; the signpost is here so a caller can tell a wrong shop from a wrong answer.',
      };
    }
    // LAST, because it is the only place that can see everything this host attached. The two
    // siblings above sit OUTSIDE the preimage the engine hashed, and the recipe the response
    // publishes told a caller to recompute over "this response WITHOUT its `proof` key" and nothing
    // else — so a caller who wrapped their body in `params` and followed the instruction got a
    // mismatch, on the exhibit the paper invites them to re-derive. `sealContentHashRecipe` names
    // what to strip, derives the names rather than repeating them here, and re-checks the hash
    // before the response leaves. See src/util/recipe.js.
    return sealContentHashRecipe(answer);
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
