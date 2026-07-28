// PRE-DEPLOY PREFLIGHT — the seatbelt.
//
// The claim this deploy rests on is "nothing risky changes: the codeHash holds, published proofs keep
// reproducing, the service list and the endpoint do not move, and the worst case is three minutes of
// a dark container". That is a claim, and a claim nobody has tested is the thing this project keeps
// finding wrong in its own work. So this measures it, against the LIVE service, before anything ships.
//
// It is deliberately paranoid about the one thing the new code could break that no test would notice:
// the repair layer rewrites the request body, the ECHOED INPUTS come from that body, and the
// contentHash is taken over the echoed inputs. If a request that already worked comes out repaired,
// its contentHash moves and a published proof stops reproducing. That is checked here against every
// service, not reasoned about.
//
//   node gates/preflight.mjs
//
// Exit 0 means safe to deploy. Anything else means do not.
import { SERVICES } from '../src/services.js';
import { repairBody } from '../src/util/repair.js';
import { suggestService } from '../src/util/routing.js';
import { handleRpc } from '../src/mcp.js';
import { _internal, engineSourceFiles } from '../src/engine/proof.js';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIVE = process.env.QUIVER_LIVE || 'https://quiver-production-c3a8.up.railway.app';

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass: !!pass });
  console.log(`  [${pass ? 'PASS' : '*** FAIL ***'}] ${name}${detail ? `\n           ${detail}` : ''}`);
  return !!pass;
};

console.log(`PREFLIGHT — ${new Date().toISOString()}\n  against ${LIVE}\n`);

// ── 1. the hash has not moved ────────────────────────────────────────────────────────────────────
const localHash = _internal.buildId();
let liveBuild = null;
try { liveBuild = await (await fetch(`${LIVE}/build`)).json(); } catch (e) { /* reported below */ }
check('the live service answers /build', !!liveBuild?.codeHash, liveBuild ? `live ${liveBuild.codeHash}` : 'no response');
check('the codeHash is unchanged, so this deploy triggers no re-review',
  !!liveBuild && liveBuild.codeHash === localHash,
  `local ${localHash} vs live ${liveBuild?.codeHash}`);

// The rule behind the hash has to still describe the tree it hashes, or the claim is about a
// different directory than the one that shipped.
const files = engineSourceFiles(join(ROOT, 'src', 'engine'));
check('the engine file list matches what /build publishes',
  !!liveBuild && liveBuild.hashRule?.fileCount === files.length,
  `local ${files.length} files vs live ${liveBuild?.hashRule?.fileCount}`);

// ── 2. nothing that would trigger a re-review ────────────────────────────────────────────────────
const liveIndex = await (async () => { try { return await (await fetch(`${LIVE}/`, { headers: { accept: 'application/json' } })).json(); } catch { return null; } })();
const liveCount = liveIndex ? Object.keys(liveIndex.services || {}).length : -1;
const localCount = SERVICES.filter((s) => s.register !== false).length;
check('the service count is unchanged', liveCount === localCount, `live ${liveCount} vs local ${localCount}`);
check('the endpoint URL is unchanged', LIVE.includes('quiver-production-c3a8'), LIVE);
check('the identity is unchanged', liveIndex?.identity?.erc8004AgentId === 5152, `agent ${liveIndex?.identity?.erc8004AgentId}`);

// ── 3. THE ONE THAT MATTERS: repair must not touch a body that already works ─────────────────────
// A body the validator already accepts must come out of repairBody byte-identical, or its echoed
// inputs change, or its contentHash changes, and a published proof stops reproducing.
const mutated = [];
for (const s of SERVICES) {
  const props = s.inputSchema?.properties || {};
  // Build every body a caller might plausibly send that ALREADY validates: the required set, and the
  // required set plus each optional property in turn. One optional at a time, because that is where an
  // alias collision would hide.
  const req = s.inputSchema?.required || [];
  const sample = (spec) => (Array.isArray(spec.enum) ? spec.enum[0]
    : spec.type === 'number' || spec.type === 'integer' ? 1
    : spec.type === 'boolean' ? true
    : spec.type === 'array' ? []
    : spec.type === 'object' ? {}
    : 'x');
  const base = {};
  for (const k of req) base[k] = sample(props[k] || {});

  const candidates = [base];
  for (const k of Object.keys(props)) {
    if (k in base) continue;
    candidates.push({ ...base, [k]: sample(props[k]) });
  }

  for (const body of candidates) {
    const before = JSON.stringify(body);
    const { body: after, repairs } = repairBody(s, body);
    if (JSON.stringify(after) !== before || repairs.length) {
      mutated.push(`${s.name}: ${before} -> ${JSON.stringify(after)} (${repairs.map((r) => r.note).join('; ')})`);
    }
  }
}
check('repair leaves every already-valid body byte-identical, so no contentHash moves',
  mutated.length === 0,
  mutated.length ? mutated.slice(0, 5).join('\n           ') : `swept ${SERVICES.length} services and every optional field of each`);

// And the signpost must stay silent on all of them too, or correct paid answers grow a wrong notice.
const noisy = [];
for (const s of SERVICES) {
  const req = s.inputSchema?.required || [];
  if (!req.length) continue;
  const props = s.inputSchema.properties || {};
  const body = {};
  for (const k of req) body[k] = Array.isArray(props[k]?.enum) ? props[k].enum[0] : props[k]?.type === 'number' ? 1 : 'x';
  if (suggestService(s, body, SERVICES)) noisy.push(s.name);
}
check('the routing signpost stays silent on correct calls', noisy.length === 0, noisy.join(', ') || `${SERVICES.length} services quiet`);

// Any service that builds a Plonk proof must snap its inputs onto the grid the circuit works over,
// or the proof certifies an identity a few 1e-6 away from the one the answer reports.
//
// WHY IT LIVES IN PREFLIGHT rather than in `test/`. It belongs to deploy time: the way this invariant
// breaks is somebody wiring a proof onto a second service and shipping it. Preflight is the one thing
// that always runs before `railway up`, and a gate in `gates/` with its own npm script is a gate that
// quietly stops being run, which already happened once here.
//
// It reads the handlers themselves rather than sweeping the source file, so moving code between files
// cannot make it silently stop matching. The distinction it turns on is easy to get backwards:
//   proofEnvelope(...)              the ordinary signed-response wrapper. Nearly every service.
//   env.proof / buildInBackground   an actual Plonk proof built off-request. This is the trigger.
//
// `portfolio-gate` was reported as a defect for never snapping. It emits no zk proof at all, so there
// was nothing for a buyer to receive; `zk/circuits/portfoliogate.circom` is gated under `zk/` and
// reaches no served path. The moment that changes, this check is what says so.
const EMITS_ZK = /env\.proof|buildInBackground/;
const SNAPS = /gridSnapFields\s*\(/;
const handlers = SERVICES.map((s) => ({ name: s.name, body: String(s.run || '') }));
const emitting = handlers.filter((h) => EMITS_ZK.test(h.body)).map((h) => h.name).sort();
// Asserted first: a stringify that returned "[native code]" or empty bodies would find nothing and
// report success over nothing, which is how a check stops being able to fail.
check('the proof-emitting services are actually visible to this check',
  emitting.length > 0,
  emitting.length ? `found ${emitting.join(', ')}` : `NOTHING MATCHED across ${handlers.length} handlers — this check proved nothing`);
check('every service that builds a zk proof snaps its inputs onto that grid first',
  handlers.every((h) => !EMITS_ZK.test(h.body) || SNAPS.test(h.body)),
  handlers.filter((h) => EMITS_ZK.test(h.body) && !SNAPS.test(h.body)).map((h) => h.name).join(', ')
    || `${emitting.join(', ')} snap; the other ${handlers.length - emitting.length} build no proof`);
check('the proof-emitting set is the one that has been checked',
  emitting.length === 1 && emitting[0] === 'perp-gate',
  `[${emitting.join(', ')}] — a new entry needs its circuit's grid decided on purpose, not inherited`);

// ── 4. the new code paths actually run ───────────────────────────────────────────────────────────
// A 500 discovered in production is the failure this deploy is supposed to avoid, so every MCP tool is
// called here with a body that exercises repair, and none of them may throw.
let toolsRun = 0, toolsThrew = [];
const toolList = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
for (const t of toolList.result.tools) {
  try {
    const r = await handleRpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: t.name, arguments: { params: {} } } });
    if (!r.result && !r.error) toolsThrew.push(`${t.name}: no result`);
    else toolsRun++;
  } catch (e) {
    toolsThrew.push(`${t.name}: ${e.message}`);
  }
}
check('every MCP tool survives a wrapped, empty argument set', toolsThrew.length === 0,
  toolsThrew.length ? toolsThrew.join('; ') : `${toolsRun} tools called, none threw`);

// ── 5. the static assets a judge reads have not moved ────────────────────────────────────────────
let same = 0, parts = 0;
for (let i = 1; i <= 40; i++) {
  const f = join(ROOT, 'assets', `whitepaper.part${i}.md`);
  if (!existsSync(f)) break;
  parts++;
  try {
    const live = await (await fetch(`${LIVE}/paper/${i}`)).text();
    if (live === readFileSync(f, 'utf8')) same++;
  } catch { /* counted as a mismatch */ }
}
check('every paper part is still byte-identical to live', parts > 0 && same === parts, `${same} of ${parts}`);

// ── 6. the changelog is not stale ────────────────────────────────────────────────────────────────
// The promise at /changelog is that behaviour changes are dated and published. A deploy that changes
// what callers see without a changelog entry breaks that promise, and it breaks it during judging.
const changelog = readFileSync(join(ROOT, 'assets', 'changelog.md'), 'utf8');
const liveChangelog = await (async () => { try { return await (await fetch(`${LIVE}/changelog`)).text(); } catch { return null; } })();
check('the changelog has an entry this deploy has not yet published',
  liveChangelog !== null && changelog !== liveChangelog,
  changelog === liveChangelog
    ? 'the repo changelog is IDENTICAL to live — add the entry for this deploy before shipping'
    : 'the repo changelog is ahead of live, as it should be right before a deploy');

// ── verdict ──────────────────────────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.pass);
console.log(`\n${'='.repeat(72)}`);
if (failed.length) {
  console.log(`PREFLIGHT FAILED — DO NOT DEPLOY`);
  for (const f of failed) console.log(`  · ${f.name}`);
} else {
  console.log('PREFLIGHT PASSED — safe to deploy');
  console.log('  The residual risk is the container being dark while the new one boots.');
  console.log('  Run gates/watchdog.mjs in another shell BEFORE `railway up`, not after.');
}
process.exit(failed.length ? 1 : 0);
