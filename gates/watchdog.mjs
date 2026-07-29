// DEPLOY WATCHDOG — start this BEFORE `railway up`, not after.
//
// Started first, it records what "healthy" looked like before anything changed, so the moment the
// container goes dark is a measurement rather than a guess, and so "it came back" means "it came back
// answering the same things correctly" instead of "something responded".
//
// It watches for three transitions and names each one out loud:
//   HEALTHY -> DARK      the old container stopped answering; the clock starts here
//   DARK -> HEALTHY      something is answering again; the checks below decide whether it is right
//   HEALTHY -> NEW       the deploy marker appeared, so the new code is the one serving
//
// The alarm threshold is 5 minutes of continuous darkness, which is the line Tristan set. It is
// printed loudly rather than merely returned, because whoever is watching at midnight should not have
// to read a JSON blob to learn that something is wrong.
//
//   node gates/watchdog.mjs                      poll until the new build is up and healthy
//   node gates/watchdog.mjs --alarm 300          override the alarm threshold, in seconds
//
// Exit 0 = the new build is live and every check passes. Exit 1 = the alarm fired.
const LIVE = process.env.QUIVER_LIVE || 'https://quiver-production-c3a8.up.railway.app';
const ALARM_S = Number((process.argv.find((a) => a.startsWith('--alarm='))
  || `--alarm=${process.argv[process.argv.indexOf('--alarm') + 1] || 300}`).split('=')[1]) || 300;
const EVERY_MS = 5000;

// The marker that says the NEW code is serving. Not the codeHash, which is deliberately unchanged and
// therefore proves nothing about which container answered.
//
// IT HAS TO BE CONFIGURABLE, AND THIS SCRIPT WAS ABANDONED THREE TIMES BECAUSE IT WAS NOT. The default
// below was `/build.proofStorage`, chosen when that key existed only in unshipped code. It shipped. On
// every deploy after that the marker was ALREADY PRESENT at baseline, and the success condition further
// down requires `!baseline.newBuild` — correct, and silent. The script did not declare a false success;
// it hung, forever, saying nothing about why. So three deploys were watched by throwaway scripts
// written from scratch instead, and the third of them recorded nothing at all, which is why nobody can
// say how long it was dark.
//
// A marker must be something only THIS deploy can produce. Pass one:
//   --marker build.someNewKey        a dotted path into /build that must appear
//   --marker index.services.length>22
// and if none is given, the default is used and checked at baseline like any other.
// A `/build` key is not always available, and this script was bypassed a FOURTH time because of it.
// The deploy that shipped `elapsedMs` and `excludedFromContentHash` added nothing to `/build` at all —
// both live inside the answer a service returns — so there was no dotted path to point at, and yet
// another throwaway poller was written and `gates/deploy-log.tsv` stayed empty. A log nothing writes to
// is not a record, so the marker forms have to cover where the evidence actually is.
//
//   --marker build.someNewKey                     a dotted path into /build
//   --marker call:perp_gate:proof.elapsedMs       a dotted path into an MCP tool's ANSWER
//
// The call form needs a body. `--marker-args '{"entryPrice":64000,…}'` supplies one; without it the
// tool is called with `{}`, which reaches the validator and stops — enough for a field the envelope
// always carries, useless for anything behind a branch. It says which it used.
const markerArg = (process.argv.find((a) => a.startsWith('--marker=')) || '').split('=')[1]
  || (process.argv.includes('--marker') ? process.argv[process.argv.indexOf('--marker') + 1] : null);
const markerArgsRaw = (process.argv.find((a) => a.startsWith('--marker-args=')) || '').split('=').slice(1).join('=')
  || (process.argv.includes('--marker-args') ? process.argv[process.argv.indexOf('--marker-args') + 1] : null);
let MARKER_ARGS = {};
if (markerArgsRaw) {
  try { MARKER_ARGS = JSON.parse(markerArgsRaw); }
  catch (e) { console.log(`FATAL: --marker-args is not JSON: ${e.message}`); process.exit(2); }
}
const MARKER_DESC = markerArg || 'build.proofStorage';
const dig = (o, path) => path.split('.').reduce((v, k) => (v == null ? v : v[k]), o);
const present = (v) => v !== undefined && v !== null && v !== false;

const callMarker = markerArg && markerArg.startsWith('call:')
  ? { tool: markerArg.split(':')[1], path: markerArg.split(':').slice(2).join(':') }
  : null;

// Reads /build. Returns false for a call-form marker, which is resolved separately against a live answer.
const NEW_BUILD_MARKER = (build) => {
  if (!build || callMarker) return false;
  if (!markerArg) return Object.prototype.hasOwnProperty.call(build, 'proofStorage');
  const p = markerArg.startsWith('build.') ? markerArg.slice(6) : markerArg;
  return present(dig(build, p));
};

// Resolves a `call:` marker by asking the service a real question and reading its answer. A failure to
// reach it is NOT a false marker — it is darkness, and the caller already tracks that — so this returns
// null rather than false and the caller leaves the marker undecided.
async function callMarkerPresent() {
  if (!callMarker) return null;
  try {
    const r = await fetch(`${LIVE}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: callMarker.tool, arguments: MARKER_ARGS } }),
      signal: AbortSignal.timeout(10_000),
    });
    const j = await r.json();
    const text = j?.result?.content?.[0]?.text;
    if (!text) return null;
    return present(dig(JSON.parse(text), callMarker.path));
  } catch { return null; }
}

const stamp = () => new Date().toISOString().slice(11, 19);

// THE LOG EXISTS BECAUSE THE THIRD DEPLOY HAS NO NUMBER. This script printed its darkness figure to
// stdout and wrote nothing, so when three published documents later disagreed about how many deploys
// there had been and which one went dark, the answer had to be reconstructed from commit timestamps —
// and the third deploy's darkness could not be recovered at all, because nobody had captured the
// terminal. A measurement that exists only in a scrollback is a measurement that will be lost.
//
// It starts empty and earns its rows. Nothing is backfilled from commit messages, because a log whose
// first entries are reconstructions teaches a reader to trust reconstructions.
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOG = join(dirname(fileURLToPath(import.meta.url)), 'deploy-log.tsv');
function recordDeploy(row) {
  try {
    if (!existsSync(LOG)) {
      writeFileSync(LOG, '# Written by gates/watchdog.mjs on every completed deploy. Never edited by hand,\n'
        + '# never backfilled. A deploy with no row here was watched by something else, or not watched.\n'
        + 'startedUtc\tliveUtc\tdarkSeconds\tservices\tmcpTools\tcodeHash\tmarker\n', 'utf8');
    }
    appendFileSync(LOG, [STARTED_UTC, new Date().toISOString(), row.darkS, row.services, row.mcpTools, row.codeHash, MARKER_DESC].join('\t') + '\n', 'utf8');
    console.log(`     recorded in gates/deploy-log.tsv — commit it, that is the point`);
  } catch (e) {
    // A failed write must be loud. Silently losing the row is the defect this whole function exists for.
    console.log(`     *** COULD NOT WRITE ${LOG}: ${e.message} — capture this terminal by hand ***`);
  }
}
const STARTED_UTC = new Date().toISOString();

async function probe() {
  const t0 = Date.now();
  const out = { at: Date.now(), ms: 0, ok: false, checks: {} };
  try {
    const b = await fetch(`${LIVE}/build`, { signal: AbortSignal.timeout(10_000) });
    out.ms = Date.now() - t0;
    if (!b.ok) { out.status = b.status; return out; }
    const build = await b.json();
    out.checks.build = true;
    out.codeHash = build.codeHash;
    out.newBuild = NEW_BUILD_MARKER(build);

    // Answering is not the same as working. A container that serves /build and 500s on the paid path
    // is the failure this watchdog exists to catch, and it would look perfectly healthy on a ping.
    const idx = await fetch(`${LIVE}/`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    const index = await idx.json();
    out.checks.services = Object.keys(index.services || {}).length;

    const paid = await fetch(`${LIVE}/api/perp-gate`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      signal: AbortSignal.timeout(10_000),
    });
    out.checks.paidReturns402 = paid.status === 402;

    const mcp = await fetch(`${LIVE}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      signal: AbortSignal.timeout(10_000),
    });
    const tools = await mcp.json();
    out.checks.mcpTools = tools?.result?.tools?.length || 0;

    if (callMarker) {
      const m = await callMarkerPresent();
      if (m !== null) out.newBuild = m;   // null means unreachable, which is darkness, not absence
    }

    out.ok = out.checks.build && out.checks.services > 0 && out.checks.paidReturns402 && out.checks.mcpTools > 0;
  } catch (e) {
    out.error = String(e.name === 'TimeoutError' ? 'timeout' : e.message).slice(0, 60);
  }
  out.ms = out.ms || Date.now() - t0;
  return out;
}

console.log(`WATCHDOG — ${LIVE}`);
console.log(`  polling every ${EVERY_MS / 1000}s · alarm after ${ALARM_S}s of continuous darkness`);
console.log(`  waiting for the marker: ${MARKER_DESC}${markerArg ? '' : '  (default — pass --marker if this deploy needs its own)'}\n`);

let state = null;           // 'healthy' | 'dark'
let darkSince = null;
let baseline = null;
let alarmed = false;
let maxDarkMs = 0;

for (;;) {
  const p = await probe();
  const now = p.ok ? 'healthy' : 'dark';

  if (baseline === null && p.ok) {
    baseline = { services: p.checks.services, mcpTools: p.checks.mcpTools, codeHash: p.codeHash, newBuild: p.newBuild };
    console.log(`${stamp()}  baseline: ${baseline.services} services · ${baseline.mcpTools} MCP tools · ${baseline.codeHash} · ${baseline.newBuild ? 'NEW build already live' : 'old build serving'}`);
    console.log(`${stamp()}  marker: ${MARKER_DESC}`);

    // REFUSE LOUDLY RATHER THAN WAIT FOREVER. If the marker is already true before the deploy starts,
    // the success condition below can never fire, and this script used to simply loop in silence until
    // whoever started it gave up and wrote their own. It happened three times. A marker that is already
    // present is not a small configuration slip: it means this run cannot tell the old build from the
    // new one, so anything it reports afterwards would be about nothing.
    if (baseline.newBuild) {
      console.log(`\n${'!'.repeat(72)}`);
      console.log(`${stamp()}  REFUSING TO WATCH: the marker "${MARKER_DESC}" is ALREADY TRUE at baseline.`);
      console.log('  This run could not distinguish the old container from the new one, so it would either');
      console.log('  hang forever or declare success over the build that is already serving.');
      console.log('  Pick something only THIS deploy can produce, then start again:');
      console.log('    node gates/watchdog.mjs --marker build.someKeyThisDeployAdds');
      console.log(`${'!'.repeat(72)}\n`);
      process.exit(2);
    }
  }

  if (now !== state) {
    if (now === 'dark') {
      darkSince = Date.now();
      console.log(`${stamp()}  ⚠ DARK — ${p.error || `status ${p.status}`}. Clock started.`);
    } else {
      const downS = darkSince ? Math.round((Date.now() - darkSince) / 1000) : 0;
      if (darkSince) maxDarkMs = Math.max(maxDarkMs, Date.now() - darkSince);
      console.log(`${stamp()}  ✓ ANSWERING again after ${downS}s · ${p.checks.services} services · ${p.checks.mcpTools} MCP tools · ${p.ms}ms`);
      darkSince = null;
      alarmed = false;
    }
    state = now;
  }

  // A regression that answers is worse than a container that does not, because nothing alerts on it.
  if (p.ok && baseline) {
    if (p.checks.services !== baseline.services) {
      console.log(`${stamp()}  ✖ SERVICE COUNT CHANGED: ${baseline.services} -> ${p.checks.services}. ROLL BACK.`);
    }
    if (p.checks.mcpTools !== baseline.mcpTools) {
      console.log(`${stamp()}  ✖ MCP TOOL COUNT CHANGED: ${baseline.mcpTools} -> ${p.checks.mcpTools}. ROLL BACK.`);
    }
    if (p.codeHash !== baseline.codeHash) {
      console.log(`${stamp()}  ✖ CODEHASH MOVED: ${baseline.codeHash} -> ${p.codeHash}. This deploy was supposed to be hash-neutral. ROLL BACK.`);
    }
  }

  if (darkSince && !alarmed && Date.now() - darkSince > ALARM_S * 1000) {
    alarmed = true;
    console.log(`\n${'!'.repeat(72)}`);
    console.log(`${stamp()}  ALARM — dark for over ${ALARM_S}s. This is past the agreed threshold.`);
    console.log('  Check Railway logs, then `railway rollback`. Nothing here writes to disk or to chain,');
    console.log('  so a rollback is complete and leaves no residue.');
    console.log(`${'!'.repeat(72)}\n`);
    process.exitCode = 1;
  }

  if (p.ok && p.newBuild && baseline && !baseline.newBuild) {
    const darkS = Math.round(maxDarkMs / 1000);
    console.log(`\n${stamp()}  ★ NEW BUILD IS LIVE and healthy.`);
    console.log(`     ${p.checks.services} services · ${p.checks.mcpTools} MCP tools · codeHash ${p.codeHash} (unchanged, as intended)`);
    console.log(`     darkness: ${darkS}s${maxDarkMs ? '' : ' — the service answered every poll through the swap'}`);
    console.log('     Now verify by hand: /changelog carries today\'s entry, and /paper/1..7 still match the repo.');
    recordDeploy({ darkS, services: p.checks.services, mcpTools: p.checks.mcpTools, codeHash: p.codeHash });
    process.exit(process.exitCode || 0);
  }

  await new Promise((r) => setTimeout(r, EVERY_MS));
}
