// The scripted revert for gateBuyer.
//
// gateBuyer-mistakes.mjs is the gate guarding the failure mode this project exists for: a reviewer's
// agent that sends a slightly wrong body and does not understand what comes back. It has sixteen
// checks and, until this file, had never been shown able to fail even once. `deploy-manifest.md`
// nevertheless described BOTH buyer gates as "proven able to fail by scripted revert". Only gateP was.
//
// That claim mattered more than most, because this gate has already let a defect through. See
// `gates/gateP-paid-teaching.mjs:14`: every check of the teaching layer called `repairBody` +
// `correctedExample` directly (this file) or went through `/mcp`, and not one ever put a
// PAYMENT-SIGNATURE header on a request — so a paying caller received the prose of a refusal and none
// of the retry, while the free MCP caller got the corrected body. A gate that cannot fail cannot tell
// you which half of the surface it is standing on.
//
// So each defect is put back into the real file, one at a time, and gateBuyer is required to go RED
// naming it — and green again once the file is restored, because red-in-both-states is a broken gate.
//
//   1. PLAUSIBLE-DEFAULTS  the teaching layer hands back `0` / `long` / `false` where it now writes
//                          `<description>`. A refusal that shows a plausible-looking body is worse
//                          than one that shows nothing: an agent sends it back unread. Must go red on
//                          "a placeholder, not a plausible default".
//
//   2. EMPTY-EXAMPLE       `correctedExample` reads only the flat `required` list again — the shape
//                          that handed perp-gate's caller an EMPTY example, since perp-gate declares
//                          no `required` and expresses "margin OR leverage" through anyOf. This is the
//                          historical defect, restored verbatim. Must name the services it breaks.
//
//   3. LOOSE-NUMBERS       "64,000", "64k" and "$64000" get parsed instead of refused. Each has more
//                          than one reading, so parsing decides the caller's position size for them.
//                          THE CONFIDENT-WRONG-ANSWER SHAPE — a repair that guesses.
//
//   4. ALIAS-OVERWRITE     an alias is applied OVER a value the caller actually supplied, so
//                          `{address:"0xAAA", token:"0xBBB"}` scans the wrong token. Silent data loss.
//
//   5. WRAPPER-GREEDY      unwrapping fires on a wrapper key that is not alone, discarding every other
//                          field the caller sent. THE OVER-FIRE SHAPE — a repair that does too much is
//                          a defect in the same way one that does too little is, and a revert suite
//                          with no over-fire in it only proves the guard is present, not that it is
//                          correctly bounded.
//
//   6. FOREIGN-KEY-BLIND   the mis-route signpost loses the branch the comment in routing.js calls
//                          "THE CASE THAT ACTUALLY COST TWO STARS": a body that satisfies the service
//                          it was sent to while carrying another service's required field. The call
//                          SUCCEEDS and answers a question nobody asked, so no refusal message can
//                          help — the signpost is the only thing that can.
//
// COMPANION MEASUREMENT, not a pass condition. Each revert also runs `gateR-misroute`, and whether
// that gate catches the same defect is reported either way. Where it stays green, gateBuyer is the only
// thing holding that behaviour; where it goes red too, this file says so rather than implying sole
// custody.
//
// WHY NOT preflight, which is what the other reverts in this directory use. It was tried first and it
// does not work here. preflight makes six network calls to the live service, and those checks fail as a
// CLUSTER whenever the network hiccups — so three consecutive runs of this file over identical code
// reported "4 of 6 held by gateBuyer alone", then 2, then 3. Taking the baseline twice and excluding
// whatever drifted between them was not enough: a check can be green in both baselines and still flake
// red during one of the six revert windows, and it is then credited to that revert as a finding.
// A companion that answers differently each run cannot support a sentence in a published document, and
// the sentence this file exists to make true is in one. `gateR-misroute` makes zero network calls, so
// its answer is the same every time. The coverage figure below was stable across all of it.
//
// TARGETS `src/util/repair.js` and `src/util/routing.js` only — the two files gateBuyer's sixteen
// checks actually own. It does not touch `src/mcp.js` or `src/services.js`, and it verifies both target
// files back to their exact starting sha256 before it will report a result.
//
//   node gates/gateBuyer-revert.mjs        (npm run gate:buyer-revert)
import { readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const F = {
  repair: join(ROOT, 'src', 'util', 'repair.js'),
  routing: join(ROOT, 'src', 'util', 'routing.js'),
};
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

function runTestFile(file) {
  return () => {
    const r = spawnSync(process.execPath, ['--test', join(ROOT, 'gates', file)], { cwd: ROOT, encoding: 'utf8', timeout: 300_000 });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    const pass = Number((out.match(/^# pass (\d+)$/m) || out.match(/^ℹ pass (\d+)$/m) || [])[1] ?? -1);
    const fail = Number((out.match(/^# fail (\d+)$/m) || out.match(/^ℹ fail (\d+)$/m) || [])[1] ?? -1);
    if (pass < 0 || fail < 0) {
      console.error(out);
      throw new Error(`could not read the runner summary for ${file} — the numbers below would be invented`);
    }
    const failedNames = [...new Set([
      ...[...out.matchAll(/^not ok \d+ - (.+?)$/gm)].map((m) => m[1].trim()),
      ...[...out.matchAll(/^✖ (.+?) \(\d/gm)].map((m) => m[1].trim()),
    ])];
    if (fail > 0 && !failedNames.length) {
      console.error(out);
      throw new Error(`${file} reported ${fail} failure(s) and this script could not name any of them`);
    }
    return { pass, fail, failedNames, raw: out, passedNames: [...out.matchAll(/^(?:ok \d+ - |✔ )(.+?)(?: \(\d|$)/gm)].map((m) => m[1].trim()) };
  };
}
const runGateBuyer = runTestFile('gateBuyer-mistakes.mjs');
const runGateR = runTestFile('gateR-misroute.mjs');

// The baseline is still taken twice, before and after, and a check only counts as caught by the
// companion if it was green in BOTH. gateR is deterministic so the two should always agree — and if they
// ever do not, that is reported rather than averaged away.
const companionDelta = (stableGreen, after) => {
  const added = after.failedNames.filter((n) => stableGreen.has(n));
  return { added, caught: added.length > 0 };
};

const REVERTS = [
  {
    name: 'PLAUSIBLE-DEFAULTS — the refusal hands back a body that looks sendable instead of visible placeholders',
    file: 'repair',
    find: '    example[k] = k in body ? body[k] : `<${spec.description || spec.type || \'value\'}>`;',
    replace: "    example[k] = k in body ? body[k] : (spec.type === 'number' || spec.type === 'integer' ? 0 : spec.type === 'boolean' ? false : spec.type === 'array' ? [] : spec.type === 'object' ? {} : String(spec.enum?.[0] ?? 'default'));   // SCRIPTED REVERT: a plausible default an agent will send back unread",
    expect: /placeholder|filled in|not a guess/i,
    expectRaw: /a placeholder, not a plausible default/,
    named: 'the gate\'s own words: "a placeholder, not a plausible default"',
  },
  {
    name: 'EMPTY-EXAMPLE — correctedExample reads only the flat `required` list, so a service that declares none teaches nothing',
    file: 'repair',
    find: '  const keys = needed.length ? needed : Object.keys(props).filter((k) => props[k].description).slice(0, 6);',
    replace: "  const keys = [...new Set(schema.required || [])].filter((k) => props[k]);   // SCRIPTED REVERT: the shape that handed perp-gate's caller an empty example",
    expect: /actionable|filled in|shape it should have had/i,
    expectRaw: /these refuse without showing what to send: .+/,
    named: 'the gate names the services it broke',
  },
  {
    name: 'LOOSE-NUMBERS — "64,000" / "64k" / "$64000" are parsed instead of refused, deciding the position size for the caller',
    file: 'repair',
    find: `    if (!/^-?\\d+(\\.\\d+)?([eE][-+]?\\d+)?$/.test(t)) continue;
    body[k] = Number(t);`,
    replace: `    const loose = t.replace(/[$,\\s]/g, '').replace(/k$/i, '000');   // SCRIPTED REVERT: "be helpful" about 64,000 and 64k
    if (!/^-?\\d+(\\.\\d+)?([eE][-+]?\\d+)?$/.test(loose)) continue;
    body[k] = Number(loose);`,
    expect: /NOT plainly a number/i,
    expectRaw: /64,000 must not be parsed/,
    named: 'the gate quotes back the exact string it refused to guess at',
  },
  {
    name: 'ALIAS-OVERWRITE — an alias is applied over a value the caller actually supplied',
    file: 'repair',
    find: '    if (alias in body && !(canonical in body) && known.has(canonical)) {',
    replace: '    if (alias in body && known.has(canonical)) {   // SCRIPTED REVERT: the alias now wins over the caller\'s own canonical value',
    expect: /alias never overwrites/i,
    expectRaw: /the canonical key wins; the alias is not applied over it/,
    named: 'the gate\'s own words: "the canonical key wins"',
  },
  {
    name: 'WRAPPER-GREEDY — unwrapping fires on a wrapper key that is NOT alone, discarding every other field sent',
    file: 'repair',
    find: '  if (keys.length === 1 && WRAPPERS.includes(keys[0]) && isPlainObject(body[keys[0]])) {',
    replace: '  const greedy = keys.find((k) => WRAPPERS.includes(k) && isPlainObject(body[k]));   // SCRIPTED REVERT: over-fire\n  if (greedy) {',
    replaceAlso: { find: '    body = { ...body[keys[0]] };', replace: '    body = { ...body[greedy] };   // SCRIPTED REVERT' },
    alsoFind: '    repairs.push({ kind: \'unwrapped\', note: `params were nested under "${keys[0]}" and have been read from there` });',
    alsoReplace: '    repairs.push({ kind: \'unwrapped\', note: `params were nested under "${greedy}" and have been read from there` });   // SCRIPTED REVERT',
    expect: /wrapper key that is NOT alone/i,
    expectRaw: /a wrapper key that is NOT alone is left alone/,
    named: 'the check title, which is the requirement itself',
  },
  {
    name: 'FOREIGN-KEY-BLIND — the mis-route signpost loses the branch that catches a call which SUCCEEDS at the wrong shop',
    file: 'routing',
    find: '  const foreignWins = best.f.shape === 1 && foreign.length > 0;',
    replace: '  const foreignWins = false;   // SCRIPTED REVERT: the succeeding mis-route loses its signpost — the exact call that cost two stars',
    expect: /half-star calls/i,
    expectRaw: /the two half-star calls both get a signpost/,
    named: 'the check title — the call that succeeds and answers the wrong question',
  },
];

console.log('GATEBUYER REVERT — proving the buyer-mistake checks can fail, and saying which of them another gate also holds\n');

const originals = Object.fromEntries(Object.entries(F).map(([k, p]) => [k, readFileSync(p, 'utf8')]));
const startSha = Object.fromEntries(Object.entries(F).map(([k, p]) => [k, sha(p)]));
for (const [k, p] of Object.entries(F)) console.log(`  ${k.padEnd(8)} ${p.replace(ROOT, '.')}  sha256 ${startSha[k].slice(0, 16)}…`);

for (const r of REVERTS) {
  const missing = [r.find, r.alsoFind, r.replaceAlso?.find].filter(Boolean).filter((lit) => !originals[r.file].includes(lit));
  if (missing.length) {
    console.error(`\nThe code this revert removes is no longer in ${F[r.file]}:\n  ${r.name}`);
    for (const m of missing) console.error(`  missing literal: ${m.slice(0, 110)}…`);
    console.error('Refusing to run: a revert that does not apply would report a meaningless result.');
    process.exit(2);
  }
}

const base = runGateBuyer();
console.log(`\n  baseline gateBuyer : ${base.pass} pass, ${base.fail} fail`);
if (base.fail !== 0 || base.pass === 0) {
  console.error('  Not green before any revert, so nothing below would mean anything.');
  process.exit(2);
}
const basePre = runGateR();
console.log(`  baseline gateR     : ${basePre.pass} pass, ${basePre.fail} fail  (companion; zero network calls)`
  + `${basePre.fail ? ` (pre-existing, not this change: ${basePre.failedNames.join('; ')})` : ''}`);

const BACKUPS = Object.fromEntries(Object.entries(F).map(([k, p]) => [k, `${p}.revert-backup`]));
for (const [k, p] of Object.entries(F)) copyFileSync(p, BACKUPS[k]);

const results = [];
try {
  for (const r of REVERTS) {
    // Re-read rather than trusting the snapshot: this repository has more than one agent in it, and
    // writing a stale `originals` back over somebody else's edit would be a far worse defect than the
    // one being demonstrated.
    if (readFileSync(F[r.file], 'utf8') !== originals[r.file]) {
      throw new Error(`${F[r.file]} changed underneath this run — aborting before anything is overwritten`);
    }
    let next = originals[r.file].replace(r.find, r.replace);
    if (r.alsoFind) next = next.replace(r.alsoFind, r.alsoReplace);
    if (r.replaceAlso) next = next.replace(r.replaceAlso.find, r.replaceAlso.replace);
    writeFileSync(F[r.file], next);

    const out = runGateBuyer();
    const pre = runGateR();
    const delta = { pending: pre };   // resolved against the second baseline once the run is over

    console.log(`\n  revert: ${r.name}`);
    console.log(`    gateBuyer against reverted code : ${out.pass} pass, ${out.fail} fail`);
    for (const n of out.failedNames) console.log(`      RED: ${n}`);
    const hit = (out.raw.match(r.expectRaw) || [])[0];
    console.log(`      NAMED: ${hit ? `${hit}  (${r.named})` : '(the gate did not name the defect this revert put back)'}`);
    console.log(`      gateR: ${pre.pass} pass, ${pre.fail} fail (resolved against both baselines at the end)`);

    results.push({ ...r, out, hitNames: out.failedNames.filter((n) => r.expect.test(n)), rawHit: r.expectRaw.test(out.raw), delta });
    // Restored one at a time, never measured on a pile.
    for (const [k, p] of Object.entries(F)) writeFileSync(p, originals[k]);
  }
} finally {
  // In `finally` because leaving a reverted source file behind after a crash is far worse than a failed
  // gate: the next run would look green against code nobody meant to ship.
  for (const [k, p] of Object.entries(F)) { copyFileSync(BACKUPS[k], p); rmSync(BACKUPS[k], { force: true }); }
  const bad = Object.entries(F).filter(([k, p]) => sha(p) !== startSha[k]).map(([k]) => k);
  if (bad.length) {
    console.error(`*** RESTORE FAILED for ${bad.join(', ')} — restore from the mirror before doing anything else ***`);
    process.exit(3);
  }
  console.log('\n  all files restored, both back to their starting sha256');
}

const back = runGateBuyer();
console.log(`  gateBuyer against restored code : ${back.pass} pass, ${back.fail} fail`);

// The second baseline, on restored code. Only checks green in BOTH baselines can be credited to a
// revert; anything that moved between them moved on its own.
const endPre = runGateR();
const drifted = [...new Set([...basePre.failedNames, ...endPre.failedNames])]
  .filter((n) => basePre.failedNames.includes(n) !== endPre.failedNames.includes(n));
const stableGreen = new Set(basePre.passedNames.filter((n) => endPre.passedNames.includes(n)));
console.log(`  gateR baseline, re-taken        : ${endPre.pass} pass, ${endPre.fail} fail`
  + `${drifted.length ? ` — DRIFTED on: ${drifted.join('; ')}` : ' — stable across the run, as a gate with no network call should be'}`);
if (drifted.length) {
  console.log('    A companion with no network call should not move. It did, so the companion column below');
  console.log('    is not trustworthy on this run and these checks are excluded rather than credited.');
}
for (const r of results) Object.assign(r.delta, companionDelta(stableGreen, r.delta.pending));
console.log();

console.log('='.repeat(78));
let ok = true;
for (const r of results) {
  const wentRed = r.out.fail > 0;
  const rightCheck = r.hitNames.length > 0;
  const good = wentRed && rightCheck && r.rawHit;
  ok = ok && good;
  console.log(`  [${good ? 'PASS' : '*** FAIL ***'}] ${r.name.split(' — ')[0]}`);
  console.log(`           ${wentRed ? `${r.out.fail} check(s) failed` : 'THE GATE STAYED GREEN'}`
    + `${rightCheck ? `, including: ${r.hitNames[0]}` : ', but not the check that owns this defect'}`);
  console.log(`           ${r.rawHit ? 'and it named the defect the revert put back' : 'but it did not name the defect — the check may not reach it'}`);
  console.log(`           gateR: ${r.delta.caught ? `also red — ${r.delta.added.join('; ')}` : 'green — sole custody sits with gateBuyer'}`);
}
const cameBack = back.fail === 0 && back.pass === base.pass;
console.log(`  [${cameBack ? 'PASS' : '*** FAIL ***'}] gateBuyer is green again once the files are restored (${back.pass}/${base.pass})`);
ok = ok && cameBack;

const sole = results.filter((r) => !r.delta.caught).length;
console.log(`\n  ${sole} of ${results.length} reverts are held by gateBuyer ALONE; gateR caught the other ${results.length - sole}.`);

// COUNTED, NOT CLAIMED. "This gate can fail" is not "every check in this gate can fail", and the
// difference is the whole subject of this file. The union of checks these reverts actually turn red is
// computed here so the coverage figure published in deploy-manifest.md is a measurement — and so that
// adding a revert moves the number by itself.
const covered = [...new Set(results.flatMap((r) => r.out.failedNames))].sort();
const uncovered = base.passedNames.filter((n) => !covered.includes(n));
console.log(`\n  COVERAGE: ${covered.length} of ${base.pass} checks are turned red by at least one revert here.`);
for (const n of covered) console.log(`    covered   ${n}`);
for (const n of uncovered) console.log(`    NO REVERT ${n}`);
console.log(`\n  The ${uncovered.length} unreverted checks are not thereby proven sound — they are simply not yet`);
console.log('  shown able to fail, which is the state this whole gate was in before this file existed.');

console.log(`\nGATEBUYER REVERT: ${ok ? `PASSED — ${covered.length} of the ${base.pass} checks go red on a real defect and green again on restore` : 'FAILED'}`);
process.exit(ok ? 0 : 1);
