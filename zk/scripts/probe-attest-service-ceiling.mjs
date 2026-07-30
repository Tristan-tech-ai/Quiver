// How big a batch can risk-attest actually be asked for? Measured against the real express stack.
//
// WHY THIS DECIDES SOMETHING. probe-attest-public-input-cost.mjs found that a set-exactness SNARK only
// becomes gas-cheaper than the direct check somewhere past N=256, once the leaves are priced as public
// inputs. Whether that regime is reachable is not a matter of opinion: `app.js` caps the request body,
// and a batch is 64 hex characters per leaf. So the largest batch the service will accept is a hard
// number, and this probe finds it by BISECTING REAL HTTP REQUESTS rather than by dividing the cap by an
// assumed bytes-per-leaf.
//
// The bisection is bracketed by a measured pass and a measured fail, and both ends are asserted, so a
// ceiling cannot be reported from a request that failed for some unrelated reason.
//
// Run: node zk/scripts/probe-attest-service-ceiling.mjs   (writes zk/build/probe-attest-service-ceiling.json)
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { BUILD } from './lib/gatekit.mjs';
import { serviceRoot } from './service-root.mjs';

const { url: SRC, label } = serviceRoot(import.meta.url);
const app = (await import(new URL('app.js', SRC).href)).default;

console.log(`PROBE — the largest batch risk-attest will accept — ${new Date().toISOString()}`);
console.log(`  service source: ${label}\n`);

const h = (s) => createHash('sha256').update(s).digest('hex');
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const port = server.address().port;

// An unpaid POST returns the 402 challenge, which is still a decisive answer to "did the body get
// through": a 413 is the body being refused, a 402 is the body being accepted and payment being asked
// for. Distinguishing those two is the whole measurement, so both are recorded rather than collapsed
// into ok/not-ok.
async function tryN(n) {
  const body = JSON.stringify({ contentHashes: Array.from({ length: n }, (_, i) => h('c' + i)) });
  const res = await fetch(`http://127.0.0.1:${port}/api/risk-attest`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body,
  });
  let payload = null;
  try { payload = await res.json(); } catch { payload = null; }
  return { n, bodyBytes: Buffer.byteLength(body), status: res.status, bodyAccepted: res.status !== 413, code: payload?.error ?? null };
}

const samples = [];
// Bracket first: a small batch must be accepted and a large one must be refused, or the bisection below
// would be searching for a boundary that is not there.
const small = await tryN(1);
samples.push(small);
if (!small.bodyAccepted) throw new Error(`a 1-leaf batch was refused with ${small.status} — the probe cannot calibrate`);
let hiFail = 1;
for (const n of [64, 256, 1024, 4096]) {
  const r = await tryN(n); samples.push(r);
  if (!r.bodyAccepted) { hiFail = n; break; }
}
if (hiFail === 1) throw new Error('no batch size in the bracket was refused — the body cap did not engage, so there is no ceiling to report');

let lo = 1, hi = hiFail;
while (hi - lo > 1) {
  const mid = Math.floor((lo + hi) / 2);
  const r = await tryN(mid);
  samples.push(r);
  if (r.bodyAccepted) lo = mid; else hi = mid;
}
// Assert the boundary from both sides, measured, not inferred from the loop's final state.
const atCeiling = await tryN(lo);
const overCeiling = await tryN(hi);
samples.push(atCeiling, overCeiling);
if (!atCeiling.bodyAccepted) throw new Error(`N=${lo} was expected to pass and did not`);
if (overCeiling.bodyAccepted) throw new Error(`N=${hi} was expected to be refused and was not`);

await new Promise((r) => server.close(r));

console.log(`  largest batch the body cap admits : N=${lo}  (${atCeiling.bodyBytes} bytes, HTTP ${atCeiling.status}${atCeiling.code ? ` ${atCeiling.code}` : ''})`);
console.log(`  first batch refused               : N=${hi}  (${overCeiling.bodyBytes} bytes, HTTP ${overCeiling.status}${overCeiling.code ? ` ${overCeiling.code}` : ''})`);
console.log(`  bytes per leaf, measured          : ${((overCeiling.bodyBytes - atCeiling.bodyBytes) / (hi - lo)).toFixed(1)}`);

const artifact = {
  at: new Date().toISOString(),
  passed: true,
  question: 'Is the N at which a set-exactness SNARK would win on gas even reachable through the service?',
  maxLeavesAccepted: lo,
  firstLeafCountRefused: hi,
  bytesAtCeiling: atCeiling.bodyBytes,
  statusAtCeiling: atCeiling.status,
  statusOverCeiling: overCeiling.status,
  bytesPerLeafMeasured: Number(((overCeiling.bodyBytes - atCeiling.bodyBytes) / (hi - lo)).toFixed(1)),
  samples,
  note: 'Measured by bisecting real POSTs against the express app, with the pass and fail ends of the boundary each asserted. A 402 means the body was accepted and payment was demanded; a 413 means the body was refused. The distinction is what is being measured, so the two are not collapsed.',
};
writeFileSync(path.join(BUILD, 'probe-attest-service-ceiling.json'), `${JSON.stringify(artifact, null, 2)}\n`);
console.log(`\n  artifact zk/build/probe-attest-service-ceiling.json`);
