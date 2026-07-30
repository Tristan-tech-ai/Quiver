// GATE MR — a TRANSIENT refusal must not be memoised, and a PERMANENT one must stay cheap to re-derive.
//
// WHAT IT IS FOR. `src/util/snark.js` answers `/proof/<hash>` out of a 200-entry Map, and all seven proof
// builders opened with the same guard against proving one content hash twice:
//
//     if (store.has(contentHash) || claimed.has(contentHash)) return;
//
// `store.has` treats every record in that Map as a settled answer. Two of the four statuses the file
// writes are not answers at all. The one that hurts is this, written when the 8-deep queue is full:
//
//     put(contentHash, { status: 'unavailable', error: `prover busy — 8 proofs already queued; retry shortly` })
//
// That record satisfied `store.has`, so the identical request never rebuilt — not when the prover went
// idle, not ever, until the entry fell out of the cache, which for a hash nobody else is asking for means
// 200 further distinct proof requests. The sentence says "retry shortly" and retrying did nothing.
//
// MEASURED ON THE SERVED HANDLER BEFORE ANY CODE MOVED, not argued: twelve distinct `event-vol` bodies
// with `snark: true` saturate the queue (8 admitted, 4 refused), a thirteenth gets
// `unavailable: prover busy`, and after the prover goes completely idle — 12.2 s for the eight ahead of
// it — the IDENTICAL body leaves the record untouched: same status, same `at` stamp. `src/util/proofStore.js`
// had the opposite policy in writing for the durable layer, and had had it longer: it refuses to persist
// `failed`/`unavailable` because "a refusal is a judgement made by one build of the code. Persisting it
// would let a fixed prover keep serving the old refusal after a deploy. Cheap to redo."
//
// ── WHY EVERY CHECK HERE IS BEHAVIOURAL ──────────────────────────────────────────────────────────
// The obvious version of this gate greps the seven guards. A textual probe for `observationEnvelope` in
// this same repository reported 22 of 22 services and was wrong, because the call it was looking for sat
// in a nested helper. So nothing below reads source: every assertion drives a real handler — `SERVICES[].run`
// on the paid surface AND `TOOLS[].run` on the free MCP one, which has been the forgotten site four times —
// and reads the real store through `getProof`.
//
// ── AND WHY IT CANNOT PASS OVER NOTHING ──────────────────────────────────────────────────────────
// "The retry rebuilt" passes trivially on a process where the queue was never full, because then the
// first attempt was never refused. So saturation is asserted first, on each surface, as its own floor:
// exactly MAX_QUEUED legs must be admitted, the rest must carry the transient sentence, and the target's
// FIRST attempt must be one of the refused. Those floors are green under every revert in
// gateMR-revert.mjs — that is what makes them a floor rather than a restatement of the stars.
//
// ── THE OTHER HALF: A REFUSAL THAT IS NOT TRANSIENT ──────────────────────────────────────────────
// `unavailable` also covers PERMANENT refusals — the display ceilings, the encoders' witness reasons.
// Making those retryable is only safe if re-deriving one is idempotent and cheap, so both are measured
// rather than assumed (MR.6, MR.7), and so is the property a caller acts on: a permanent refusal must
// keep its own sentence instead of being masked by the transient one.
//
//   node --test gates/gateMR-memoised-refusal.mjs   (npm run gate:mr)
//   node gates/gateMR-revert.mjs                    (npm run gate:mr-revert)
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (...p) => pathToFileURL(join(ROOT, ...p)).href;

const { SERVICES } = await import(url('src', 'services.js'));
const { TOOLS } = await import(url('src', 'mcp.js'));
const { getProof, stopProver } = await import(url('src', 'util', 'snark.js'));
const proofStore = await import(url('src', 'util', 'proofStore.js'));

// MEMORY-ONLY, ASSERTED RATHER THAN HOPED FOR. With a durable store configured, a `ready` record from an
// earlier run would answer the first attempt and no leg could ever be refused for a full queue — the
// floors below would go red for a reason that has nothing to do with this defect. The durable path is
// gate A's subject; this one is about the in-memory guard in front of it.
assert.equal(proofStore.kind(), 'in-memory only',
  `this gate needs a memory-only store to saturate a queue; QUIVER_PROOF_DIR/S3 is set (${proofStore.kind()})`);

const svc = (n) => { const s = SERVICES.find((x) => x.name === n); assert.ok(s, `no such service: ${n}`); return s; };
const tool = (n) => { const t = TOOLS.find((x) => x.name === n); assert.ok(t, `no such MCP tool: ${n}`); return t; };

const tick = () => new Promise((r) => setImmediate(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const transient = (rec) => rec?.status === 'unavailable' && /prover busy/.test(rec.error || '');

/** Poll until this hash is not `building` any more, the way every documented caller polls. */
async function settle(h, tries = 600) {
  let rec = null;
  for (let i = 0; i < tries; i++) {
    rec = await getProof(h);
    if (rec && rec.status !== 'building') return rec;
    await sleep(100);
  }
  return rec;
}

/**
 * Wait until nothing at all is in the prover, so a retry is competing with nobody.
 *
 * THE GRACE AT THE END IS NOT PADDING, and it was measured: `queued--` runs in the `.finally()` of the
 * queue link, which is one turn LATER than the `ready` record the poller sees. Returning the moment the
 * last record settles left one slot still counted as occupied, and the round that followed had seven legs
 * admitted instead of eight — which is a false RED on this file's own floor rather than a defect in the
 * service. The service is right: no caller can observe `queued`, only whether it is admitted.
 */
async function idle(hashes = [], budgetMs = 240_000) {
  const t0 = Date.now();
  for (;;) {
    let inFlight = 0;
    for (const h of hashes) if ((await getProof(h))?.status === 'building') inFlight++;
    if (!inFlight) { await sleep(150); return (Date.now() - t0) / 1000; }
    if (Date.now() - t0 > budgetMs) return -((Date.now() - t0) / 1000);
    await sleep(200);
  }
}

/**
 * Wait for the record under this hash to be REWRITTEN — a new `at` — and then for it to settle.
 *
 * A plain poll-until-not-`building` cannot express this and reads the wrong record: a memoised refusal is
 * ALREADY not `building`, so the poll returns the stale entry before the retry's builder has even had its
 * first microtask, and the check would then report the old refusal for a retry that did rebuild. So the
 * rewrite is what is waited for, which is also the behavioural statement worth making — "the store moved"
 * rather than "the store says something I like".
 */
async function rebuilt(h, prevAt, budgetMs = 15_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < budgetMs) {
    const r = await getProof(h);
    if (r && r.at !== prevAt) return settle(h);
    await sleep(25);
  }
  return getProof(h);   // never rewritten; the caller's assertion is what says so
}

// MAX_QUEUED is 8 in snark.js. Twelve distinct legs therefore admit eight and refuse four, without the
// 20,200-leg flood gate IF needs — this defect wants a FULL QUEUE, not an evicted cache, and keeping the
// two causes apart is why nothing here evicts anything.
const ADMITTED = 8;
const FILLERS = 12;

// Pinned, because a fixture whose hash moved would be a different request and every number below would
// be about something else. Measured on this tree, 30 July 2026.
const HTTP_TARGET = { spot: 61234.5, atmIvPct: 62, daysToEvent: 11 };
const HTTP_PINNED = 'ca935a5b4e3c731be7ec481438aa04053eb94d2d4efce797d6345d828a69979e';
const MCP_TARGET = { spot: 58321.25, atmIvPct: 71, daysToEvent: 5 };
const MCP_PINNED = '0c3f4b9a4fc2ac60f7654c3eeb7dae8db26863ccdb8880ac7f180581526d47d1';

// Three PERMANENT refusals, one per shape, each reached through a served handler rather than by calling a
// builder directly: the perp-gate display ceiling (a position the 1e-9 grid cannot pin to the half-cent
// the price is shown at), the exec-verify encoder's dust-fill reason, and the lp-risk bracket ceiling —
// the expensive one, because its witness replays a 200-halving bisection.
const PERMANENT = [
  { label: 'perp-gate display ceiling', name: 'perp-gate', mcp: 'perp_gate', match: /cannot pin this position/,
    hash: '9f76337c8d9432c0aaf5964077ee5a2ecb8bd1396425293697db4fec4680e770',
    body: { side: 'long', entryPrice: 33.218586195485344, size: 1.4979449840075012e-9, maintMarginRate: 1.2759854069276015e-9, leverage: 4.3200491333557 } },
  { label: 'exec-verify dust fill', name: 'exec-verify', mcp: 'exec_verify', match: /cannot pin this benchmark fill/,
    hash: '5b1fe7008c23ce66a6d8ef2b9890217653b3ac5dc8b2d4b85f56fb0ca0e30ce5',
    body: { amountIn: 1e-9, amountOutRealized: 0.9e-9, reserveIn: 1e6, reserveOut: 1e6, feeTier: 0.003 } },
  { label: 'lp-risk breakeven ceiling', name: 'lp-risk', mcp: 'lp_risk', match: /cannot pin this breakeven/,
    hash: '02080b7c330aaa2cd2083927bfdae4be5295a59f8d7ca54306f879533f14d002',
    body: { volatility: 0.05, horizonPeriods: 1, feeAprPct: 0.0001, periodsPerYear: 365 } },
];

// MR.9's fixture, proved before anything else in this file runs. See MR.0 for why the order matters.
const OWN_TARGET = { spot: 51500, atmIvPct: 38, daysToEvent: 21 };
const OWN_PINNED = '8ad5b6605676fcfe20258acaa1136372aa9b7ed858b382c402bc13267af7cbf1';

const state = { http: {}, mcp: {}, own: {} };

// ── ONE PROOF FIRST, SO THE LAST CHECK CANNOT INHERIT ANOTHER'S FAILURE ──────────────────────────

test('MR.0 one proof of its own on a quiet prover — the fixture MR.9 is about', async () => {
  // INDEPENDENCE IS WHAT MAKES A REVERT ATTRIBUTABLE, and this file has now been wrong about it twice.
  // MR.9 asks whether a FINISHED proof is ever thrown away. Reading round one's target instead of proving
  // its own made MR.9 fail whenever MR.3 failed; proving its own at the END made it fail whenever the queue
  // was full, which the fourth revert in gateMR-revert.mjs arranges deliberately. Both were cascades rather
  // than findings, and both were caught by the revert script reporting a companion check going red. So the
  // fixture is proved HERE, on a prover nothing else in this file has touched yet.
  const ev = svc('event-vol');
  const env = ev.run({ ...OWN_TARGET, snark: true });
  state.own.hash = env.proof.contentHash;
  assert.equal(state.own.hash, OWN_PINNED, 'the pinned MR.9 fixture hash moved');
  const rec = await settle(state.own.hash);
  console.log(`    /proof/${state.own.hash.slice(0, 12)} → ${rec?.status}`);
  assert.equal(rec?.status, 'ready', `the prover cannot prove anything in this process: ${rec?.status}${rec?.error ? `: ${rec.error}` : ''}`);
  state.own.at = rec.at;
  state.own.proof = rec.proof;
});

// ── ROUND ONE: the paid HTTP surface ─────────────────────────────────────────────────────────────

test('MR.1 the queue really fills and the target request is refused for it — the floor this gate would otherwise pass over', async () => {
  const ev = svc('event-vol');
  const fillers = [];
  for (let i = 0; i < FILLERS; i++) fillers.push(ev.run({ spot: 40000 + i, atmIvPct: 50, daysToEvent: 7, snark: true }).proof.contentHash);
  const env = ev.run({ ...HTTP_TARGET, snark: true });
  state.http.hash = env.proof.contentHash;
  state.http.fillers = fillers;
  assert.equal(state.http.hash, HTTP_PINNED, 'the pinned event-vol target hash moved');

  // The requests are synchronous; the builders reach the queue on the next turn of the loop, which is all
  // the served path gets between two requests and is exactly what the defect needed.
  for (let i = 0; i < 5; i++) await tick();

  let building = 0, busy = 0;
  for (const h of fillers) {
    const r = await getProof(h);
    if (r?.status === 'building') building++;
    else if (transient(r)) busy++;
  }
  const target = await getProof(state.http.hash);
  console.log(`    ${building} of ${FILLERS} fillers admitted, ${busy} refused for a full queue`);
  console.log(`    target /proof/${state.http.hash.slice(0, 12)} → ${target?.status}: ${(target?.error || '').slice(0, 60)}`);
  assert.equal(building, ADMITTED, `${building} legs were admitted, not MAX_QUEUED (${ADMITTED}) — the queue was not saturated and nothing below is tested`);
  assert.equal(busy, FILLERS - ADMITTED, `${busy} legs carried the transient refusal, expected ${FILLERS - ADMITTED}`);
  assert.ok(transient(target), `the target's first attempt was not refused for a full queue: ${target?.status} ${target?.error || ''}`);
  state.http.firstAt = target.at;
  state.http.firstError = target.error;
});

test('★ MR.2 a build that is IN FLIGHT is not overwritten by a repeat of its own request', async () => {
  // The companion claim, and it is not the same claim: `building` must still block. `claimed` is released
  // when a build is ENQUEUED, so from enqueue to `ready` this record is the only marker that the hash is in
  // the prover — and with the queue full, a duplicate build would write `unavailable: prover busy` over a
  // proof that is being proved. That is the defect gates/gateIF-inflight-eviction.mjs was added for,
  // reached here through a full queue instead of an evicted cache.
  const ev = svc('event-vol');
  let inFlight = null;
  for (const h of state.http.fillers) if ((await getProof(h))?.status === 'building') inFlight = h;
  assert.ok(inFlight, 'no filler is in the prover any more, so this check has no in-flight record to protect');
  const i = state.http.fillers.indexOf(inFlight);
  const again = ev.run({ spot: 40000 + i, atmIvPct: 50, daysToEvent: 7, snark: true });
  assert.equal(again.proof.contentHash, inFlight, 'the repeat produced a different content hash');
  for (let k = 0; k < 5; k++) await tick();
  const rec = await getProof(inFlight);
  console.log(`    repeat of an in-flight leg → ${rec?.status}${rec?.error ? `: ${rec.error.slice(0, 60)}` : ''}`);
  assert.equal(rec?.status, 'building',
    `an in-flight build was overwritten with ${rec?.status}${rec?.error ? `: ${rec.error}` : ''}`);
});

test('★ MR.3 once the prover is idle, the IDENTICAL request rebuilds — "retry shortly" means something', async () => {
  const ev = svc('event-vol');
  const secs = await idle(state.http.fillers);
  assert.ok(secs >= 0, `the prover never went idle within the budget (${-secs}s)`);
  console.log(`    prover idle after ${secs.toFixed(1)}s`);
  const again = ev.run({ ...HTTP_TARGET, snark: true });
  assert.equal(again.proof.contentHash, state.http.hash, 'the repeat produced a different content hash');
  const rec = await rebuilt(state.http.hash, state.http.firstAt);
  console.log(`    /proof/${state.http.hash.slice(0, 12)} → ${rec?.status} (was ${state.http.firstError?.slice(0, 40)}…)`);
  assert.equal(rec?.status, 'ready',
    `the retry did not rebuild: ${rec?.status}${rec?.error ? `: ${rec.error}` : ''}`);
  assert.notEqual(rec.at, state.http.firstAt, 'the record was never rewritten, so nothing was rebuilt');
  // And it is the proof of the answer that was served, reconstructed the way the record tells a buyer to.
  const nHat = Number(rec.encoded.nHat);
  const served = ev.run({ ...HTTP_TARGET }).expectedMove.straddleImpliedAbsMoveUsd;
  const R = 2 * HTTP_TARGET.spot * (2 * (nHat / 2 ** 40) - 1);
  console.log(`    2*${HTTP_TARGET.spot}*(2*${nHat}/2^40 - 1) = ${R} → ${Math.round(R * 100) / 100}, served ${served}`);
  assert.equal(Math.round(R * 100) / 100, served, 'the rebuilt record does not reconstruct the served field');
});

// ── ROUND TWO: the free MCP surface, which has been the forgotten site four times ─────────────────

test('MR.4 the MCP surface fills the same queue and refuses the same way — its own floor', async () => {
  const ev = tool('event_vol');
  // Round one's last queue slot is given back one turn after its record says `ready`; starting here
  // without waiting for that leaves seven slots and this floor reports a defect that is not there.
  await idle([...state.http.fillers, state.http.hash]);
  const fillers = [];
  for (let i = 0; i < FILLERS; i++) fillers.push(ev.run({ spot: 30000 + i, atmIvPct: 45, daysToEvent: 9, snark: true }).proof.contentHash);
  const env = ev.run({ ...MCP_TARGET, snark: true });
  state.mcp.hash = env.proof.contentHash;
  state.mcp.fillers = fillers;
  assert.equal(state.mcp.hash, MCP_PINNED, 'the pinned MCP event_vol target hash moved');
  for (let i = 0; i < 5; i++) await tick();
  let building = 0, busy = 0;
  for (const h of fillers) {
    const r = await getProof(h);
    if (r?.status === 'building') building++;
    else if (transient(r)) busy++;
  }
  const target = await getProof(state.mcp.hash);
  console.log(`    ${building} of ${FILLERS} MCP fillers admitted, ${busy} refused for a full queue`);
  assert.equal(building, ADMITTED, `${building} MCP legs were admitted, not MAX_QUEUED (${ADMITTED})`);
  assert.ok(transient(target), `the MCP target's first attempt was not refused for a full queue: ${target?.status} ${target?.error || ''}`);
  state.mcp.firstAt = target.at;
});

test('★ MR.5 the MCP surface retries too — the same fix, asserted on the surface that keeps being missed', async () => {
  const ev = tool('event_vol');
  const secs = await idle(state.mcp.fillers);
  assert.ok(secs >= 0, `the prover never went idle within the budget (${-secs}s)`);
  console.log(`    prover idle after ${secs.toFixed(1)}s`);
  const again = ev.run({ ...MCP_TARGET, snark: true });
  assert.equal(again.proof.contentHash, state.mcp.hash, 'the MCP repeat produced a different content hash');
  const rec = await rebuilt(state.mcp.hash, state.mcp.firstAt);
  console.log(`    /proof/${state.mcp.hash.slice(0, 12)} → ${rec?.status}`);
  assert.equal(rec?.status, 'ready', `the MCP retry did not rebuild: ${rec?.status}${rec?.error ? `: ${rec.error}` : ''}`);
  assert.notEqual(rec.at, state.mcp.firstAt, 'the MCP record was never rewritten, so nothing was rebuilt');
});


// ── THE PERMANENT HALF ───────────────────────────────────────────────────────────────────────────
//
// `unavailable` is two different things wearing one status. Making it retryable is only honest if the
// PERMANENT ones — the display ceilings, the encoders' witness reasons — stay cheap to re-derive, keep
// their own sentence, and never queue work. Each of those is measured below rather than assumed, and the
// order matters: the masking check runs BEFORE the re-attempt storm, so a revert that makes a refusal leak
// a queue slot turns exactly one check red instead of every check downstream of it.

test('★ MR.6 with the queue full, a PERMANENT refusal keeps its own sentence instead of being masked by the transient one', async () => {
  // This is what makes the retry safe to advertise. If a permanently-refused request were told
  // "prover busy — retry shortly" whenever the queue happened to be full, a caller following that
  // instruction would retry forever for a proof that can never exist. Every refusal in snark.js is
  // therefore written BEFORE the queue is consulted; this asserts that ordering from outside the file.
  const ev = svc('event-vol');
  await idle([...state.mcp.fillers, state.mcp.hash]);
  const fillers = [];
  for (let i = 0; i < FILLERS; i++) fillers.push(ev.run({ spot: 20000 + i, atmIvPct: 65, daysToEvent: 4, snark: true }).proof.contentHash);
  state.masking = fillers;                       // set BEFORE any assertion, so MR.8 can still drain
  for (let i = 0; i < 5; i++) await tick();
  let building = 0;
  for (const h of fillers) if ((await getProof(h))?.status === 'building') building++;
  assert.equal(building, ADMITTED, `the queue is not full (${building} building), so masking cannot be observed`);

  for (const p of PERMANENT) {
    const priorAt = (await getProof(p.hash))?.at;
    await svc(p.name).run({ ...p.body, snark: true });
    // The record may already hold this refusal from an earlier leg, so what is waited for is the REWRITE.
    const rec = priorAt ? await rebuilt(p.hash, priorAt) : await settle(p.hash);
    console.log(`    ${building} in the prover · ${p.label} → ${(rec?.error || rec?.status || '').slice(0, 76)}`);
    assert.ok(!transient(rec), `${p.label}: a permanent refusal was masked by the transient one: ${rec?.error}`);
    assert.match(rec.error || '', p.match, `${p.label}: lost its own sentence under load: ${rec?.error}`);
  }
});

test('★ MR.7 a PERMANENT refusal re-derives to the same sentence every time, and re-deriving is cheap', async () => {
  const REPEATS = 50;
  await idle(state.masking);                     // measure against an idle prover, not a loaded one
  for (const p of PERMANENT) {
    const s = svc(p.name);
    const first = await s.run({ ...p.body, snark: true });
    assert.equal(first.proof.contentHash, p.hash, `${p.label}: the pinned fixture hash moved`);
    const r0 = await settle(p.hash);
    assert.equal(r0?.status, 'unavailable', `${p.label}: expected a stored refusal, got ${r0?.status}`);
    assert.match(r0.error, p.match, `${p.label}: the first refusal is not the one this case is about`);

    const sentences = new Set([r0.error]);
    const statuses = new Set([r0.status]);
    const stamps = new Set([r0.at]);
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < REPEATS; i++) {
      await s.run({ ...p.body, snark: true });
      const r = await getProof(p.hash);
      statuses.add(r?.status);
      stamps.add(r?.at);
      sentences.add(r?.status === 'unavailable' ? r.error : `STATUS:${r?.status}`);
    }
    const msWith = Number(process.hrtime.bigint() - t0) / 1e6 / REPEATS;
    const t1 = process.hrtime.bigint();
    for (let i = 0; i < REPEATS; i++) await s.run({ ...p.body });
    const msWithout = Number(process.hrtime.bigint() - t1) / 1e6 / REPEATS;

    // And on the MCP surface, which reaches the same seven builders through a different array.
    const m = await tool(p.mcp).run({ ...p.body, snark: true });
    assert.equal(m.proof.contentHash, p.hash, `${p.label}: the MCP surface hashes this body differently`);
    const rm = await getProof(p.hash);

    console.log(`    ${p.label}: ${REPEATS} re-attempts → ${sentences.size} sentence(s), statuses [${[...statuses].join(',')}], ${stamps.size} distinct 'at' (re-derivation really ran)`);
    console.log(`      cost ${(msWith - msWithout).toFixed(3)} ms/call over the same body without snark (${msWith.toFixed(3)} vs ${msWithout.toFixed(3)})`);
    assert.equal(sentences.size, 1, `${p.label}: re-attempting produced ${sentences.size} different outcomes: ${[...sentences].map((x) => String(x).slice(0, 90)).join(' || ')}`);
    assert.deepEqual([...statuses], ['unavailable'], `${p.label}: a permanent refusal changed status under re-attempt`);
    assert.match(rm.error || '', p.match, `${p.label}: the MCP surface stored a different refusal`);
    // Cheap, against a measured 0.02–1.07 ms/call — this fails loudly if a re-attempt ever starts doing
    // proving work rather than arithmetic, and is not tight enough to fail on a loaded machine.
    assert.ok(msWith - msWithout < 25, `${p.label}: re-deriving the refusal costs ${(msWith - msWithout).toFixed(1)} ms/call, which is not cheap`);
  }
});

test('★ MR.8 and re-attempting refusals never occupies the prover', async () => {
  // The cost of making refusals retryable, bounded from outside. 150 re-attempts of three permanently
  // refused bodies have just run. If any refusal path took a queue slot without giving it back, the prover
  // is now permanently full and the next honest request is refused for a queue nobody is using — which is
  // the same wrong answer this whole gate is about, arrived at from the other direction.
  const secs = await idle(state.masking);
  assert.ok(secs >= 0, `the prover never went idle within the budget (${-secs}s)`);
  const ev = svc('event-vol');
  const env = ev.run({ spot: 77777, atmIvPct: 44, daysToEvent: 3, snark: true });
  const rec = await settle(env.proof.contentHash);
  console.log(`    after the refusal storm, an honest request → ${rec?.status}${rec?.error ? `: ${rec.error.slice(0, 70)}` : ''}`);
  assert.ok(!transient(rec), `the prover is still full after only refusals ran: ${rec?.error}`);
  assert.equal(rec?.status, 'ready', `the honest request did not prove: ${rec?.status}${rec?.error ? `: ${rec.error}` : ''}`);
});

test('★ MR.9 a proof that is READY is never rebuilt — the cache still does the job it exists for', async () => {
  // The other direction of the same guard, and the reason it is a positive list rather than "retry anything
  // that is not building": proving is 703 ms of a core, and a repeat request must keep costing nothing. The
  // fixture was proved in MR.0, before anything here had touched the prover — see the note there.
  const ev = svc('event-vol');
  assert.equal(state.own.at, (await getProof(state.own.hash))?.at, 'the MR.0 fixture was rewritten by something between there and here');
  for (let i = 0; i < 50; i++) ev.run({ ...OWN_TARGET, snark: true });
  for (let i = 0; i < 5; i++) await tick();
  const after = await getProof(state.own.hash);
  console.log(`    50 repeats of a ready hash → ${after?.status}, at ${after?.at === state.own.at ? 'unchanged' : 'MOVED'}`);
  assert.equal(after?.status, 'ready', `a finished proof was thrown away and rebuilt: ${after?.status}`);
  assert.equal(after.at, state.own.at, 'the ready record was rewritten, so the proof was rebuilt');
  assert.equal(after.proof, state.own.proof, 'the stored proof object changed under a repeat request');
});

after(async () => { try { await stopProver(); } catch { /* already gone */ } });
