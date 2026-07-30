// GATE IF — a proof that is IN FLIGHT must not be evicted, and a repeat request must not overwrite it.
//
// WHAT IT IS FOR. `src/util/snark.js` answers `/proof/<hash>` out of a 200-entry Map. Six builders share
// it, and each one opens with the same guard against proving one content hash twice:
//
//     if (store.has(contentHash) || claimed.has(contentHash)) return;
//
// `claimed` is released as soon as the build is ENQUEUED, not when it settles, so from enqueue to `ready`
// the `building` record in that Map is the only thing marking the hash as in flight. The eviction was
// insertion-order and took that record like any other. The consequence, measured on the served event-vol
// handler rather than argued: a fixture call, then 20,200 further distinct-hash proof requests, then the
// SAME fixture again — the second call passes the guard, starts a duplicate build for a hash already in
// the prover, hits MAX_QUEUED, and writes `unavailable: prover busy` over it. Every poller in this
// repository stops on any status that is not `building`, so the caller is told a proof is unavailable
// while it is being proved, and the real `ready` arrives after nobody is looking.
//
// It is not a gate-only artifact. It is what a public endpoint does under any burst wider than the cache:
// the same request that answers `ready` in 3 s on a quiet process answers `unavailable` on a busy one,
// and the answer is wrong rather than merely slow.
//
// ── WHY EVERY CHECK HERE IS BEHAVIOURAL ──────────────────────────────────────────────────────────
// The obvious version of this gate greps `put()` for the eviction guard. A textual probe for
// `observationEnvelope` in this same repository reported 22 of 22 services and was wrong, because the
// call it was looking for sat in a nested helper. So nothing below reads source: every assertion drives
// the real `SERVICES[].run` handler and reads the real store through `getProof`.
//
// ── AND WHY IT CANNOT PASS OVER NOTHING ──────────────────────────────────────────────────────────
// A gate that asserts "the record is still there" passes trivially if the flood never applied any
// eviction pressure. So the pressure is asserted first, as its own floor: the flood must be accepted by
// the handler on every leg, and a record inserted early in the flood must be GONE by the end of it.
// Without that second assertion the fix could have been "never evict anything", which turns a bounded
// cache into a memory-exhaustion primitive and would have passed a one-sided version of this file.
//
//   node --test gates/gateIF-inflight-eviction.mjs   (npm run gate:if)
//   node gates/gateIF-revert.mjs                     (npm run gate:if-revert)
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (...p) => pathToFileURL(join(ROOT, ...p)).href;

const { SERVICES } = await import(url('src', 'services.js'));
const { getProof, stopProver } = await import(url('src', 'util', 'snark.js'));

const SVC = SERVICES.find((s) => s.name === 'event-vol');
assert.ok(SVC, 'there is no event-vol service — this gate describes something that is not here');

// The pinned fixture three other gates already use, so the hash below is the one they pin too.
const FIXTURE = { spot: 60000, atmIvPct: 55, daysToEvent: 7 };
const PINNED = '8d653115a9c4e8752725a63288b283c5c10c25be2ee63b92b0e48f82ba09fd8a';

// MAX is 200 in snark.js and MAX_QUEUED is 8. The flood only has to be wider than MAX to evict, but it
// is run at the size the event-vol gate actually sweeps, because that is where this was found.
const FLOOD = 20200;

const state = {};

test('the fixture request is accepted and its content hash has not moved', () => {
  const env = SVC.run({ ...FIXTURE, snark: true });
  state.hash = env.proof.contentHash;
  assert.equal(state.hash, PINNED, 'the pinned event-vol content hash moved');
  assert.equal(env.snark.status, 'building', `the handler refused the fixture: ${env.snark.reason}`);
});

test('the flood really applies eviction pressure — the floor this gate would otherwise pass over', async () => {
  let s = 20260730;
  const rand = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  let accepted = 0;
  const early = [];
  for (let i = 0; i < FLOOD; i++) {
    const spot = 10 ** (0.5 + rand() * 5.5), atmIvPct = 5 + rand() * 295, daysToEvent = 0.25 + rand() * 400;
    const env = SVC.run({ spot, atmIvPct, daysToEvent, snark: true });
    if (env.snark.status === 'building') accepted++;
    // legs 400-500 are far enough in to have been queued-out and far enough from the end to be evicted
    if (i >= 400 && i < 500) early.push(env.proof.contentHash);
  }
  state.early = early;
  console.log(`    flood: ${accepted} of ${FLOOD} legs accepted by the handler`);
  assert.equal(accepted, FLOOD, 'the flood was refused, so it never filled the cache and nothing below is tested');
  // The flood is synchronous, so nothing has been admitted to the prover yet. One turn of the loop is
  // what the served path gets between requests, and it is what the defect needed.
  await new Promise((r) => setImmediate(r));
  let gone = 0;
  for (const h of early) if ((await getProof(h)) == null) gone++;
  console.log(`    ${gone} of ${early.length} early flood records were evicted`);
  assert.ok(gone >= 90, `only ${gone} of ${early.length} early records were evicted — the cache is not bounded any more`);
});

test('★ the in-flight marker survived the flood', async () => {
  const rec = await getProof(state.hash);
  console.log(`    /proof/${state.hash.slice(0, 12)} → ${rec?.status ?? 'MISSING'}`);
  assert.ok(rec, 'the in-flight record was evicted — a duplicate build can now overwrite a proof being proved');
  assert.equal(rec.status, 'building', `expected building, got ${rec.status}${rec.error ? `: ${rec.error}` : ''}`);
});

test('★ a repeat of the in-flight request does not replace it with a transient refusal', async () => {
  const again = SVC.run({ ...FIXTURE, snark: true });
  assert.equal(again.proof.contentHash, state.hash, 'the repeat produced a different content hash');
  const rec = await getProof(state.hash);
  assert.equal(rec?.status, 'building',
    `the repeat overwrote an in-flight build with ${rec?.status}${rec?.error ? `: ${rec.error}` : ''}`);
});

test('★ and the proof the served response points at arrives', async () => {
  let rec = null;
  for (let i = 0; i < 240; i++) {
    rec = await getProof(state.hash);
    if (rec && rec.status !== 'building') break;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.equal(rec?.status, 'ready', `status ${rec?.status}${rec?.error ? `: ${rec.error}` : ''}`);
  assert.equal(rec.circuit, 'ncdf');
  assert.equal(typeof rec.straddleFromProofUsd, 'number');
  // And it is the number that was served, reconstructed the way the record tells a buyer to.
  const nHat = Number(rec.encoded.nHat);
  const served = SVC.run({ ...FIXTURE }).expectedMove.straddleImpliedAbsMoveUsd;
  const R = 2 * FIXTURE.spot * (2 * (nHat / 2 ** 40) - 1);
  console.log(`    2*${FIXTURE.spot}*(2*${nHat}/2^40 - 1) = ${R} → ${Math.round(R * 100) / 100}, served ${served}`);
  assert.equal(Math.round(R * 100) / 100, served, 'the record does not reconstruct the served field');
});

after(async () => { try { await stopProver(); } catch { /* already gone */ } });
