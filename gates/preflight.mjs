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
import { suggestService, REQUIRED_ALTERNATIVES } from '../src/util/routing.js';
import { GENUINE, UNREACHABLE_BY_SHAPE, invalidFixtures, coverageSummary, noisyOnCorrectCalls } from './routing-fixtures.mjs';
import { handleRpc, TOOLS } from '../src/mcp.js';
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

// ── 3b. the same question, asked of the third of the catalogue the sweep above cannot reach ──────
//
// `if (!req.length) continue` above is not a detail. Eight of the twenty-two declare `required: []`
// — honestly, because they accept ALTERNATIVE input forms and no single key is required across all
// of them — so the sweep synthesises an empty body for them and skips. A third of the services had
// therefore never been checked by the one check whose failure is worst, and three of them were
// failing it: a genuine portfolio-gate call carrying `positions` came back with a notice saying the
// caller had meant treasury-risk. The bodies below are written down rather than generated, because a
// requirement that is not a flat list cannot be generated from one, and each is put through the
// service's own validate() first so a stale fixture fails loudly instead of measuring nothing.
check('every fixture used below is a call the service itself would accept',
  invalidFixtures().length === 0,
  invalidFixtures().slice(0, 4).join('\n           ') || `${Object.keys(GENUINE).length} services, every accepted input form`);

const noisyAll = noisyOnCorrectCalls();
check('the signpost stays silent on a correct call to ANY of the twenty-two, including the eight',
  noisyAll.length === 0,
  noisyAll.slice(0, 5).join('\n           ') || `${SERVICES.length} services and every input form each, all quiet`);

// How much of the catalogue the signpost can NAME, swept over every ordered pair rather than
// spot-checked. A judging agent that lands on the wrong service gets a refusal it does not
// understand; this number is the fraction of the time it can be told where to go instead.
const cov = coverageSummary();
const unreachable = SERVICES.map((s) => s.name).filter((n) => !cov.reachable.has(n));
check('every service a body can single out is reachable as a redirect target',
  JSON.stringify(unreachable) === JSON.stringify(UNREACHABLE_BY_SHAPE),
  `${cov.reachable.size}/${cov.total} reachable over ${cov.rows.length} ordered pairs `
  + `(${cov.correct} correct, ${cov.misdirected} mis-directed, ${cov.silent} silent) — `
  + `unreachable [${unreachable.join(', ')}], expected [${UNREACHABLE_BY_SHAPE.join(', ')}]`);

// The table lives in routing.js keyed by service name so that no field is added to a service object
// and nothing can leak into the advertised inputSchema. Drift is the price of that, and this is where
// it is paid: a declared key that is not a real property, or a service with no flat required list and
// no entry, means the signpost and the published listing disagree about what a service needs.
const drift = [];
for (const [name, forms] of Object.entries(REQUIRED_ALTERNATIVES)) {
  const s = SERVICES.find((x) => x.name === name);
  if (!s) { drift.push(`${name}: declared, but not a service`); continue; }
  const props = new Set(Object.keys(s.inputSchema?.properties || {}));
  for (const form of forms) for (const k of form) if (!props.has(k)) drift.push(`${name}.${k} is not a property of ${name}`);
}
for (const s of SERVICES) {
  if ((s.inputSchema?.required || []).length) continue;
  if (!(s.name in REQUIRED_ALTERNATIVES)) drift.push(`${s.name}: required:[] and no entry — it can never be suggested`);
}
check('the routing table has not drifted from the schemas it describes', drift.length === 0,
  drift.slice(0, 5).join('\n           ') || `${Object.keys(REQUIRED_ALTERNATIVES).length} declarations, every key a real property`);

// The constraint that outranks the feature: an OKX re-review pulls all 22 listings back into
// moderation, and it is triggered by the ADVERTISED surface moving. The alternatives are deliberately
// not a field on the service object, so this is a proof rather than a hope.
const advertised = JSON.stringify({
  index: liveIndex ? Object.keys(liveIndex.services || {}) : null,
  schemas: SERVICES.map((s) => s.inputSchema),
});
check('nothing about the routing table reaches the advertised inputSchema',
  !/anyOfRequired|REQUIRED_ALTERNATIVES|requiredAlternatives/.test(advertised),
  'the alternatives are keyed by service name inside src/util/routing.js and never attached to a service object');

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
// THIS CHECK USED TO BE ABLE TO PASS OVER THE DEFECT IT EXISTS TO FIND.
//
// It read `SERVICES.map(s => s.run)` and nothing else. `src/mcp.js` keeps its own handler array —
// nine tools, the free surface a builder tries first — and perp_gate there calls
// `buildInBackground` with un-snapped inputs. The guard could not see that array at all, so it swept
// twenty-two handlers, found the one that already complied, and reported "every service that builds
// a zk proof snaps". Every word of that was true and the sentence was false, because "every service"
// silently meant "every service on the HTTP surface". A check that cannot reach the code where the
// invariant breaks is not a weak check, it is a decoration, and this codebase is organised against
// exactly that. It now enumerates BOTH handler arrays and asserts each is non-empty first.
// `build\w*InBackground`, NOT `buildInBackground`, AND THE DIFFERENCE WAS ALREADY LOAD-BEARING.
// The literal spelling matched exactly one of the four builders this file now guards: `buildKelly-
// InBackground`, `buildConcentrationInBackground` and `buildExecInBackground` do not contain the
// substring `buildInBackground`. Every one of them was therefore being detected only by the
// incidental `env.proof` alternative — which any handler that reads its own content hash matches,
// for any reason, whether it proves anything or not. So the trigger this comment block describes as
// "an actual Plonk proof built off-request" was in fact never matching three of the four calls that
// do it, and the set below stayed correct by luck. A fifth circuit whose handler did not happen to
// mention `env.proof` would have been invisible. Widened here so the guard sees the CALL.
const EMITS_ZK = /env\.proof|obs\.snark|build\w*InBackground/;
const SNAPS = /gridSnapFields\s*\(/;
// BOTH bodies, never one instead of the other. `SERVICES[].run` is wrapped at the foot of
// src/services.js so every response carries its own `elapsedMs`, and a closure stringifies to the
// wrapper rather than to the handler — which made this check see zero HTTP handlers and report
// `[mcp:perp_gate]` as the whole proof-emitting set. Reading the wrapper AND the function it
// published as `.unwrapped` restores exactly the source this check read before, and adds the
// wrapper's own source to it. A future wrapper that does NOT publish its inner function still
// collapses the set, and the assertion below still goes red, which is how this one was found.
const bodyOf = (fn) => `${String(fn || '')}\n${String(fn?.unwrapped || '')}`;
const handlers = [
  ...SERVICES.map((s) => ({ surface: 'http', name: s.name, body: bodyOf(s.run) })),
  ...TOOLS.map((t) => ({ surface: 'mcp', name: t.name, body: bodyOf(t.run) })),
];
const id = (h) => `${h.surface}:${h.name}`;
const emitting = handlers.filter((h) => EMITS_ZK.test(h.body)).map(id).sort();
// Asserted per SURFACE, not over the union: the whole failure above was one surface contributing
// zero handlers while the other carried the check. A union count of 22 looked healthy and was blind.
for (const surface of ['http', 'mcp']) {
  const n = handlers.filter((h) => h.surface === surface).length;
  const withBodies = handlers.filter((h) => h.surface === surface && h.body.length > 20).length;
  check(`the ${surface} handler array is visible to this check`, n > 0 && withBodies === n,
    `${withBodies} of ${n} handlers stringified to a readable body`
    + (withBodies === n ? '' : ' — an unreadable body makes this check pass over code it never examined'));
}
// Asserted first: a stringify that returned "[native code]" or empty bodies would find nothing and
// report success over nothing, which is how a check stops being able to fail.
check('the proof-emitting handlers are actually visible to this check',
  emitting.length > 0,
  emitting.length ? `found ${emitting.join(', ')}` : `NOTHING MATCHED across ${handlers.length} handlers — this check proved nothing`);
check('every handler that builds a zk proof snaps its inputs onto that grid first — on BOTH surfaces',
  handlers.every((h) => !EMITS_ZK.test(h.body) || SNAPS.test(h.body)),
  handlers.filter((h) => EMITS_ZK.test(h.body) && !SNAPS.test(h.body)).map(id).join(', ')
    || `${emitting.join(', ')} snap; the other ${handlers.length - emitting.length} build no proof`);
// FOUR ENTRIES NOW, AND EACH ADDITION IS A DECISION RECORDED HERE RATHER THAN A DRIFT NOTICED LATER.
//
//   http:perp-gate / mcp:perp_gate   the liquidation identity, over `liquidation_plonk.zkey`.
//     Grid: entryPrice, size, notional, margin, leverage, maintMarginRate, maxLeverage, markPrice.
//     Leverage is snapped even though the circuit has no term for it, because the engine DERIVES
//     margin from it and the quotient lands off-grid otherwise.
//
//   http:treasury-risk / mcp:treasury_risk   the Herfindahl identity, over `concentration_plonk.zkey`.
//     Grid: `amountUsd` on each position, and nothing else. The circuit's own inputs are the SHARES,
//     which the engine forms by grouping and dividing — no snap can put a quotient on the grid, and
//     the guard's encoding term carries a full half step per share because of it. What snapping the
//     amounts buys is that the quotient the engine divides is the double a reader recomputing from
//     `proof.inputs` would form. `apyPct`, `pegTarget` and `depegProbAnnual` reach no circuit.
//
//   http:size-gate / mcp:size_gate   the discrete-Kelly identity, over `kelly_plonk.zkey`.
//     Grid: winProb and winLossRatio, and deliberately nothing else. `kelly.circom` has terms for p
//     and b alone, so `bankroll`, `kellyFraction` and `drawdownLevels` are left where the caller put
//     them — snapping a field no circuit can see would move a content hash and buy nothing. The
//     continuous-mode pair is untouched for the same reason: f* = mu/sigma^2 is a different identity
//     with no circuit on this host, and that handler refuses a proof for it by name rather than
//     certifying the discrete statement about numbers that never entered it.
//
//   http:exec-verify / mcp:exec_verify   the adverse-execution identity, over `execadverse_plonk.zkey`.
//     Grid: amountIn, amountOutRealized, reserveIn, reserveOut, feeTier. FIVE, and the two omissions
//     were decided rather than skipped. `fairPrice` is the REFERENCE mode's benchmark — a number the
//     caller supplied instead of a pool — and execadverse.circom's invariant is about reserves, so it
//     reaches no term; that mode is refused a proof by name rather than certifying a pool statement
//     about a trade that had no pool. `slippageTolerancePct` drives the "within tolerance yet robbed"
//     lesson, which is a comparison against the headline and not a term in it. Snapping either would
//     move a content hash for a field no circuit can see, which is size-gate's argument for leaving
//     `bankroll` alone, a second time.
//
//     WHY FIVE AND NOT THREE. `execadverse.circom` takes eight public signals, and only these five
//     are the caller's: the effective input, the benchmark fill, the shortfall and the basis-point
//     figure are all DERIVED, each rounded onto the grid exactly once inside src/util/scale.cjs. So
//     snapping the five is what makes the double the engine divides the same double a reader
//     recomputing from `proof.inputs` would form — the treasury-risk argument, where the circuit's own
//     inputs are quotients the engine formed. What it buys here is larger than it is there, because
//     the benchmark is a quotient of a quotient: `dO/din` reaches 5.4e3 on a pool lopsided past 100:1,
//     so half a grid step on the effective input moves the fill by 2.7e-6 tokens, and the guard's
//     ceiling is what refuses that trade rather than certifying a neighbouring one.
//
// The list is written out rather than counted so that adding a service cannot pass by arithmetic.
check('the proof-emitting set is the one that has been checked',
  JSON.stringify(emitting) === JSON.stringify(['http:perp-gate', 'http:size-gate', 'http:treasury-risk', 'http:exec-verify', 'mcp:perp_gate', 'mcp:size_gate', 'mcp:treasury_risk', 'mcp:exec_verify'].sort()),
  `[${emitting.join(', ')}] — a new entry needs its circuit's grid decided on purpose, not inherited`);

// AND EACH CIRCUIT'S ARTIFACTS ARE ACTUALLY IN THIS BUILD. A handler that emits a proof against a key
// the deploy does not carry fails at prove time, in a worker, on a background path nobody is waiting
// on — the record lands as `failed` and the caller sees a `building` that never finishes. Deploy time
// is where that is cheap to catch, which is the same argument the grid check above is here for.
for (const [circuit, files] of Object.entries({
  liquidation: ['liquidation_plonk.zkey', 'vk_plonk.json', 'liquidation_js/liquidation.wasm', 'liquidation_js/witness_calculator.cjs'],
  kelly: ['kelly_plonk.zkey', 'kelly_vk.json', 'kelly_js/kelly.wasm', 'kelly_js/witness_calculator.cjs'],
  concentration: ['concentration_plonk.zkey', 'concentration_vk.json', 'concentration_js/concentration.wasm', 'concentration_js/witness_calculator.cjs'],
  execadverse: ['execadverse_plonk.zkey', 'execadverse_vk.json', 'execadverse_js/execadverse.wasm', 'execadverse_js/witness_calculator.cjs'],
})) {
  const missing = files.filter((f) => !existsSync(join(ROOT, 'assets', 'zk', f)));
  check(`every artifact the ${circuit} circuit proves against is in this build`, missing.length === 0,
    missing.length ? `missing under assets/zk: ${missing.join(', ')}` : `${files.length} files present`);
}

// ── 4. the new code paths actually run ───────────────────────────────────────────────────────────
// A 500 discovered in production is the failure this deploy is supposed to avoid, so every MCP tool is
// called here and none of them may throw.
//
// THE EMPTY SET IS NOT ENOUGH, AND THE COMMENT HERE USED TO CLAIM IT WAS. It said each tool was called
// "with a body that exercises repair" while the code sent `{ params: {} }` — a body that reaches the
// validator and stops. It cannot enter a branch, so it cannot find a defect inside one.
//
// That is not hypothetical. `portfolio_gate` in account mode answered `fetchHlAccount is not defined`
// in production for days: `mcp.js` called it and never imported it. This check ran green over it every
// time, because `{}` never reaches the `account` branch. It was found by a judge sweep, not here.
//
// So each tool is now called TWICE: once with the empty set, which is a real question about whether a
// bare call is survivable, and once with the body the service itself accepts, taken from the fixtures
// the routing checks already maintain and already validate against each service's own `validate()`.
// A tool with no fixture is REPORTED rather than skipped, because a silent skip is how this check
// came to cover nine tools and examine almost none of them.
const genuineFor = (toolName) => {
  const svc = toolName.replace(/_/g, '-');
  const forms = GENUINE[svc];
  if (!forms) return null;
  return Array.isArray(forms) ? forms[0] : forms;
};

let toolsRun = 0;
const toolsThrew = [], noFixture = [];
const toolList = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
for (const t of toolList.result.tools) {
  const bodies = [{ label: 'empty', args: { params: {} } }];
  const g = genuineFor(t.name);
  if (g) bodies.push({ label: 'genuine', args: g });
  else noFixture.push(t.name);

  for (const b of bodies) {
    try {
      const r = await handleRpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: t.name, arguments: b.args } });
      const text = r.result?.content?.[0]?.text || '';
      // `isError` with a validation message is a correct refusal. An exception that escaped the handler
      // and came back as a string is not, and that is the shape the account-mode crash took.
      if (!r.result && !r.error) toolsThrew.push(`${t.name}/${b.label}: no result`);
      else if (/is not defined|is not a function|Cannot read propert|undefined is not/.test(text)) {
        toolsThrew.push(`${t.name}/${b.label}: ${text.slice(0, 90)}`);
      } else toolsRun++;
    } catch (e) {
      toolsThrew.push(`${t.name}/${b.label}: ${e.message}`);
    }
  }
}
check('every MCP tool survives both an empty argument set and a body it actually accepts',
  toolsThrew.length === 0,
  toolsThrew.length ? toolsThrew.join('; ') : `${toolsRun} calls across ${toolList.result.tools.length} tools, none threw`);
check('every MCP tool has a genuine fixture, so none of them was only probed with an empty body',
  noFixture.length === 0,
  noFixture.length ? `no fixture, examined with {} only: ${noFixture.join(', ')}` : `${toolList.result.tools.length} tools, all exercised with a real body`);

// ── 5. the static assets a judge reads have not moved, or the difference is accounted for ────────
//
// THIS CHECK USED TO BE UNSATISFIABLE. It demanded every part be byte-identical to live, while
// check 6 below demands the changelog be AHEAD of live. One asked for repo == live and the other for
// repo > live, and the only state satisfying both was one in which the paper had not been touched.
// The moment the paper is legitimately corrected this went red BY CONSTRUCTION and stayed red until
// the correction was deployed — while this script is the gate that authorises the deploy. It blocked
// precisely the deploy that would have made it green.
//
// It was not deleted or loosened. It exists to catch drift in what a judge reads, and a gate
// weakened to erase a red is worse than no gate. What it now distinguishes is whether the difference
// is ACCOUNTED FOR: a part whose text differs must be declared by content hash in
// gates/paper-pending-deploy.json and covered by a changelog entry that has not yet shipped. The
// hash is what makes that more than a formality — a second, unnoticed edit to a part that was
// already named moves the hash and the declaration stops matching.
//
// It also stops reporting `0 of 7` when two parts changed. Every part's navigation header prints the
// whole-document size, so a 116-byte edit tipped `Math.round(bytes/1024)` from 247 to 248 kB and
// rewrote one line in all seven. That echo is now separated from a real change in the paper text —
// but ONLY that one line: the header also carries the part map, so anything else differing in it is
// treated as substantive, because it can be a section moving between parts.
const { assessPaperParity } = await import('./paper-integrity.mjs');
const paperParts = [];
for (let i = 1; i <= 40; i++) {
  const f = join(ROOT, 'assets', `whitepaper.part${i}.md`);
  if (!existsSync(f)) break;
  let livePart = null;
  try { livePart = await (await fetch(`${LIVE}/paper/${i}`)).text(); } catch { /* null blocks below */ }
  paperParts.push({ n: i, repo: readFileSync(f, 'utf8'), live: livePart });
}
const parity = assessPaperParity({
  parts: paperParts,
  manifest: (() => { try { return JSON.parse(readFileSync(join(ROOT, 'gates', 'paper-pending-deploy.json'), 'utf8')); } catch { return null; } })(),
  changelogRepo: readFileSync(join(ROOT, 'assets', 'changelog.md'), 'utf8'),
  changelogLive: await (async () => { try { return await (await fetch(`${LIVE}/changelog`)).text(); } catch { return null; } })(),
});
check('every difference between the repo paper and live is declared and documented', parity.pass, parity.detail);

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
