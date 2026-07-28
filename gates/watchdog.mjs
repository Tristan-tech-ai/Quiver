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
// therefore proves nothing about which container answered. `/build.proofStorage` exists only in code
// that has not shipped yet, so its appearance is unambiguous.
const NEW_BUILD_MARKER = (build) => build && Object.prototype.hasOwnProperty.call(build, 'proofStorage');

const stamp = () => new Date().toISOString().slice(11, 19);

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

    out.ok = out.checks.build && out.checks.services > 0 && out.checks.paidReturns402 && out.checks.mcpTools > 0;
  } catch (e) {
    out.error = String(e.name === 'TimeoutError' ? 'timeout' : e.message).slice(0, 60);
  }
  out.ms = out.ms || Date.now() - t0;
  return out;
}

console.log(`WATCHDOG — ${LIVE}`);
console.log(`  polling every ${EVERY_MS / 1000}s · alarm after ${ALARM_S}s of continuous darkness`);
console.log(`  waiting for the marker: /build carries "proofStorage"\n`);

let state = null;           // 'healthy' | 'dark'
let darkSince = null;
let baseline = null;
let alarmed = false;

for (;;) {
  const p = await probe();
  const now = p.ok ? 'healthy' : 'dark';

  if (baseline === null && p.ok) {
    baseline = { services: p.checks.services, mcpTools: p.checks.mcpTools, codeHash: p.codeHash, newBuild: p.newBuild };
    console.log(`${stamp()}  baseline: ${baseline.services} services · ${baseline.mcpTools} MCP tools · ${baseline.codeHash} · ${baseline.newBuild ? 'NEW build already live' : 'old build serving'}`);
  }

  if (now !== state) {
    if (now === 'dark') {
      darkSince = Date.now();
      console.log(`${stamp()}  ⚠ DARK — ${p.error || `status ${p.status}`}. Clock started.`);
    } else {
      const downS = darkSince ? Math.round((Date.now() - darkSince) / 1000) : 0;
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
    console.log(`\n${stamp()}  ★ NEW BUILD IS LIVE and healthy.`);
    console.log(`     ${p.checks.services} services · ${p.checks.mcpTools} MCP tools · codeHash ${p.codeHash} (unchanged, as intended)`);
    console.log('     Now verify by hand: /changelog carries today\'s entry, and /paper/1..7 still match the repo.');
    process.exit(process.exitCode || 0);
  }

  await new Promise((r) => setTimeout(r, EVERY_MS));
}
