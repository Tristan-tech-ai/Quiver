// The scripted revert for gate MR.
//
// A gate that has never failed is a claim, not a check. This script puts a defect back FIVE ways and
// requires gate MR to go RED each time, NAMING the case, with a named companion check that STAYS GREEN so
// the failure is attributable to the clause that caused it rather than to "something broke".
//
//   1. `store.has` BACK, IN ALL SEVEN GUARDS   the line that shipped. Every record in the 200-entry cache
//                  counts as a settled answer, including `unavailable: prover busy — retry shortly`, so the
//                  identical request never rebuilds. MR.3 (HTTP) and MR.5 (MCP) must both go red — one per
//                  surface, because the MCP array has been the forgotten site four times and a fix that
//                  covered one surface is the miss this repository keeps making. MR.2 must stay green: an
//                  in-flight build is still protected under this revert, so a gate that only asserted "the
//                  record survived" would call it healthy.
//
//   2. AN IN-FLIGHT BUILD NO LONGER BLOCKS   the positive list keeps `ready` and drops `building`. This is
//                  the over-broad version of the fix — "retry anything that is not a finished proof" — and
//                  it re-opens the defect gateIF-inflight-eviction.mjs was written for from the other end:
//                  with the queue full, a repeat of a request already in the prover writes
//                  `unavailable: prover busy` over a proof that is being proved. MR.2 must go red and MR.3
//                  must stay green, which is what makes those two assertions non-redundant.
//
//   3. A FINISHED PROOF NO LONGER BLOCKS   the list keeps `building` and drops `ready`. Nothing is refused
//                  and nothing is memoised — every repeat request re-proves an answer that was already
//                  proved, at 703 ms of a core each, which is a CPU-exhaustion primitive on a free
//                  endpoint. MR.9 must go red and MR.3 must stay green.
//
//   4. A REFUSAL THAT LEAKS A QUEUE SLOT   `queued++` before the liquidation display-ceiling refusal, and
//                  no matching decrement. Retryable refusals make this reachable in a way it was not
//                  before: 150 re-attempts of permanently refused bodies now leak 150 slots, the 8-deep
//                  queue is permanently full, and the next honest request is refused for a queue nobody is
//                  using. MR.8 must go red; MR.6 and MR.7 must stay green, because the refusal's own
//                  sentence is unchanged — the defect is in what it costs, not in what it says.
//
//   5. THE TRANSIENT CHECK FIRST   the `queued >= MAX_QUEUED` test moved to the top of `buildOnce`, ahead of
//                  the domain, same-answer and ceiling refusals. It looks like an optimisation: ask the
//                  cheap question first. It makes a PERMANENTLY refused request answer "prover busy — retry
//                  shortly" whenever the queue happens to be full, so a caller following the instruction
//                  this gate exists to make honest retries forever for a proof that can never exist. MR.6
//                  must go red and MR.7 must stay green.
//
//   node gates/gateMR-revert.mjs        (npm run gate:mr-revert)
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const FILE = (...p) => join(ROOT, ...p);
const SNARK = FILE('src', 'util', 'snark.js');

function runGateMR() {
  const r = spawnSync(process.execPath, ['--test', join(ROOT, 'gates', 'gateMR-memoised-refusal.mjs')],
    { cwd: ROOT, encoding: 'utf8', timeout: 900_000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const num = (label) => Number((out.match(new RegExp(`^(?:#|ℹ) ${label} (\\d+)$`, 'm')) || [])[1] ?? -1);
  const pass = num('pass'), fail = num('fail');
  if (pass < 0 || fail < 0) { console.error(out); throw new Error('could not read gate MR\'s runner summary — the numbers below would be invented'); }
  const failedNames = [...new Set([
    ...[...out.matchAll(/^not ok \d+ - (.+?)$/gm)].map((m) => m[1].trim()),
    ...[...out.matchAll(/^✖ (.+?) \(\d/gm)].map((m) => m[1].trim()),
  ])];
  if (fail > 0 && !failedNames.length) { console.error(out); throw new Error(`gate MR reported ${fail} failure(s) and this script could not name any of them`); }
  return { pass, fail, failedNames, out };
}

// Every `find` below is asserted to occur EXACTLY `count` times before anything is written. The guard is
// seven identical lines; a revert that patched the first one and left six would report a green gate for a
// defect that is still in the file six times over, which is the shape of miss this repository has shipped.
const REVERTS = [
  {
    name: '`store.has` BACK, IN ALL SEVEN GUARDS — the line that shipped, which memoises a transient refusal',
    find: '  if (answeredOrInFlight(contentHash) || claimed.has(contentHash)) return;',
    replace: '  if (store.has(contentHash) || claimed.has(contentHash)) return;   // SCRIPTED REVERT',
    count: 7,
    expect: [/MR\.3 /, /MR\.5 /],
    mustName: ['the retry did not rebuild', 'the MCP retry did not rebuild'],
    alsoAssert: {
      staysGreen: /MR\.2 /,
      because: 'an in-flight build is still protected under this revert, so a gate that only checked that would call it healthy',
    },
  },
  {
    name: 'AN IN-FLIGHT BUILD NO LONGER BLOCKS — the over-broad fix, which lets a duplicate overwrite a proof being proved',
    find: '  return !!rec && (rec.status === \'ready\' || rec.status === \'building\');',
    replace: '  return !!rec && rec.status === \'ready\';   // SCRIPTED REVERT: `building` no longer blocks',
    count: 1,
    expect: [/MR\.2 /],
    mustName: ['an in-flight build was overwritten'],
    alsoAssert: {
      staysGreen: /MR\.3 /,
      because: 'the transient refusal is still retryable under this revert — the two clauses of the guard are separate claims',
    },
  },
  {
    name: 'A FINISHED PROOF NO LONGER BLOCKS — every repeat re-proves, at 703 ms of a core each',
    find: '  return !!rec && (rec.status === \'ready\' || rec.status === \'building\');',
    replace: '  return !!rec && rec.status === \'building\';   // SCRIPTED REVERT: `ready` no longer blocks',
    count: 1,
    expect: [/MR\.9 /],
    mustName: ['a finished proof was thrown away and rebuilt'],
    alsoAssert: {
      staysGreen: /MR\.3 /,
      because: 'a retryable refusal is not the same claim as a memoised answer, and only one of them moved here',
    },
  },
  {
    name: 'A REFUSAL THAT LEAKS A QUEUE SLOT — reachable only because refusals are retryable now',
    find: '  if (!(w.encodingBound <= DISPLAY_HALF_UNIT)) {\n    put(contentHash,',
    replace: '  if (!(w.encodingBound <= DISPLAY_HALF_UNIT)) {\n    queued++;   // SCRIPTED REVERT: a refusal that takes a queue slot and never returns it\n    put(contentHash,',
    count: 1,
    expect: [/MR\.8 /],
    mustName: ['the prover is still full after only refusals ran'],
    alsoAssert: {
      staysGreen: /MR\.7 /,
      because: 'the refusal still says exactly the same thing — what this revert breaks is what re-deriving it COSTS',
    },
  },
  {
    name: 'THE TRANSIENT CHECK FIRST — a permanent refusal masked by "retry shortly", which makes the retry an infinite loop',
    find: 'async function buildOnce(contentHash, echoedInputs, liquidationPrice, provenance) {\n  // A proof already in the durable store',
    replace: 'async function buildOnce(contentHash, echoedInputs, liquidationPrice, provenance) {\n'
      + '  // SCRIPTED REVERT: the cheap question first, which masks every permanent refusal under load\n'
      + '  if (queued >= MAX_QUEUED) { put(contentHash, { status: \'unavailable\', error: `prover busy — ${queued} proofs already queued; retry shortly` }); return; }\n'
      + '  // A proof already in the durable store',
    count: 1,
    expect: [/MR\.6 /],
    mustName: ['a permanent refusal was masked by the transient one'],
    alsoAssert: {
      staysGreen: /MR\.7 /,
      because: 'on an idle prover the same body still gets its own sentence, so only the masking claim moves',
    },
  },
];

console.log('GATE MR REVERT — proving the memoised-refusal gate can fail\n');

const ORIGINAL = readFileSync(SNARK, 'utf8');
for (const r of REVERTS) {
  const n = ORIGINAL.split(r.find).length - 1;
  if (n !== r.count) {
    console.error(`The code this revert changes is not in ${SNARK} the expected number of times:\n  ${r.name}`);
    console.error(`  found ${n} occurrence(s), expected ${r.count}`);
    console.error(`  literal: ${r.find.slice(0, 140).replace(/\n/g, ' ⏎ ')}…`);
    console.error('Refusing to run: a revert that does not apply as written would report a meaningless result.');
    process.exit(2);
  }
}
const restore = () => writeFileSync(SNARK, ORIGINAL);

const baseline = runGateMR();
console.log(`  baseline gate MR: ${baseline.pass} pass, ${baseline.fail} fail`);
if (baseline.fail !== 0 || baseline.pass === 0) {
  console.error('  Not green before any revert, so nothing below would mean anything.');
  console.error(baseline.out.slice(-4000));
  process.exit(2);
}

const results = [];
try {
  for (const r of REVERTS) {
    writeFileSync(SNARK, ORIGINAL.split(r.find).join(r.replace));
    const out = runGateMR();
    console.log(`\n  revert: ${r.name}`);
    console.log(`    gate MR against reverted code : ${out.pass} pass, ${out.fail} fail`);
    for (const n of out.failedNames) console.log(`      RED: ${n}`);
    const wentRed = r.expect.every((e) => out.failedNames.some((n) => e.test(n)));
    const named = r.mustName.filter((s) => out.out.includes(s));
    console.log(`    names the case it is about    : ${named.length}/${r.mustName.length} [${named.join(' | ')}]`);
    const stillGreen = !out.failedNames.some((n) => r.alsoAssert.staysGreen.test(n));
    console.log(`    companion check stays green    : ${stillGreen ? 'YES' : 'NO'}`);
    console.log(`      because ${r.alsoAssert.because}`);
    results.push({ name: r.name, wentRed, fullyNamed: named.length === r.mustName.length, blindOk: stillGreen });
    restore();
  }
} finally {
  restore();
}

const restored = runGateMR();
console.log(`\n  restored gate MR: ${restored.pass} pass, ${restored.fail} fail`);

console.log('\nRESULT');
let ok = restored.fail === 0 && restored.pass === baseline.pass;
for (const r of results) {
  const good = r.wentRed && r.fullyNamed && r.blindOk;
  ok = ok && good;
  console.log(`  [${good ? 'OK' : '*** BAD ***'}] ${r.name}`);
  if (!r.wentRed) console.log('        the gate did NOT go red on the check that owns this defect');
  if (!r.fullyNamed) console.log('        the gate went red without naming the case — not an actionable failure');
  if (!r.blindOk) console.log('        the companion check that should have stayed green went red too — the failure is not attributable');
}
console.log(`\nGATE MR REVERT: ${ok ? 'PASSED' : 'FAILED'} — ${results.filter((r) => r.wentRed).length} of ${REVERTS.length} reverts turned gate MR red`);
process.exit(ok ? 0 : 1);
