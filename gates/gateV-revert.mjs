// The scripted revert for gate V.
//
// A gate that has never failed is a claim, not a check — the disease `docs/verifier-discipline.md`
// is about, and the reason this defect reached the live service with twenty-odd gates already green.
// This script puts the defect back three ways and requires gate V to go RED each time, NAMING the
// key responsible, and GREEN again once the files are restored.
//
//   1. UNSEALED    `sealContentHashRecipe` becomes the identity function. This is not an invented
//                  fault: it is the code exactly as it stands on the live service, publishing a
//                  recipe that says to remove `proof` and nothing else while the host attaches
//                  `inputRepairs`, `routingNotice`, `howToFix` and `snark` on top of it. Gate V must
//                  go red on BOTH surfaces and name the siblings.
//
//                  The companion assertion is the whole argument for this gate existing. GATE L MUST
//                  STAY GREEN under this revert. Gate L checks the same recipe — and holds the list
//                  `['inputRepairs', 'routingNotice', 'howToFix', 'snark']`, removes those keys when
//                  the verbatim recipe misses, and prints a `note:` calling them "a pre-existing
//                  sibling, not this field". It was green on 29 July while a buyer following the
//                  published instruction on the Appendix C exhibit got the wrong hash. A checker
//                  that hardcodes what to strip cannot fail on what it hardcodes.
//
//   2. NEW SIBLING, FREE SURFACE   a twelfth top-level key is attached in src/mcp.js AFTER the seal
//                  — the realistic drift, and how the four existing siblings arrived: a workstream
//                  adds one line at the bottom of a handler. The response is still sealed and still
//                  publishes an exclusion list; the list is simply missing the new name. Gate V's
//                  MCP check must go red and name `creditsRemaining`.
//
//   3. NEW SIBLING, PAID SURFACE   the same thing in src/app.js, after the seal in the paid handler.
//                  Gate V's HTTP check must go red and name `billingNotice`. Two surfaces because a
//                  fix that covered three of four call sites is the miss this repository has made
//                  repeatedly.
//
//   node gates/gateV-revert.mjs        (npm run gate:v-revert)
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const FILE = (...p) => join(ROOT, ...p);

function runner(file) {
  return () => {
    const r = spawnSync(process.execPath, ['--test', join(ROOT, 'gates', file)], { cwd: ROOT, encoding: 'utf8', timeout: 600_000 });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    const num = (label) => Number((out.match(new RegExp(`^(?:#|ℹ) ${label} (\\d+)$`, 'm')) || [])[1] ?? -1);
    const pass = num('pass'), fail = num('fail');
    if (pass < 0 || fail < 0) { console.error(out); throw new Error(`could not read ${file}'s runner summary — the numbers below would be invented`); }
    const failedNames = [...new Set([
      ...[...out.matchAll(/^not ok \d+ - (.+?)$/gm)].map((m) => m[1].trim()),
      ...[...out.matchAll(/^✖ (.+?) \(\d/gm)].map((m) => m[1].trim()),
    ])];
    if (fail > 0 && !failedNames.length) { console.error(out); throw new Error(`${file} reported ${fail} failure(s) and this script could not name any of them`); }
    return { pass, fail, failedNames, out };
  };
}
const runGateV = runner('gateV-recipe-reproduces.mjs');
const runGateL = runner('gateL-elapsed-timing.mjs');

// Each `find` is a literal that MUST be present, so a revert that no longer applies refuses to run
// rather than reporting a meaningless green.
const REVERTS = [
  {
    name: 'UNSEALED — the recipe names only `proof`, exactly as the live service publishes it today',
    target: FILE('src', 'util', 'recipe.js'),
    find: `  const excluded = postEnvelopeSiblings(response);`,
    replace: `  return response;   // SCRIPTED REVERT: nothing is sealed — the recipe stays as the engine wrote it
  const excluded = postEnvelopeSiblings(response);`,
    expect: [/following the published recipe reproduces .* paid HTTP/i, /following the published recipe reproduces .* free MCP/i, /every enveloped response was sealed/i],
    mustName: ['inputRepairs', 'routingNotice', 'howToFix', 'snark', 'fails to name'],
    alsoAssert: {
      run: runGateL,
      staysGreen: /the published recipe still reproduces/i,
      because: 'gate L hardcodes the four sibling names and removes them itself, so it cannot fail on the list it holds',
    },
  },
  {
    name: 'NEW SIBLING (free surface) — one more top-level key in src/mcp.js, attached after the seal',
    target: FILE('src', 'mcp.js'),
    find: `        sealContentHashRecipe(out);`,
    replace: `        sealContentHashRecipe(out);
        if (out && typeof out === 'object') out.creditsRemaining = { note: 'SCRIPTED REVERT: a twelfth sibling nobody told the seal about' };`,
    expect: [/following the published recipe reproduces .* free MCP/i],
    mustName: ['creditsRemaining'],
    alsoAssert: {
      run: runGateV,
      staysGreen: /following the published recipe reproduces .* paid HTTP/i,
      because: 'the drift is on one surface only, and a gate that could not tell them apart would not say where to look',
    },
  },
  {
    name: 'NEW SIBLING (paid surface) — one more top-level key in src/app.js, attached after the seal',
    target: FILE('src', 'app.js'),
    find: `    return sealContentHashRecipe(answer);`,
    replace: `    const sealed = sealContentHashRecipe(answer);
    if (sealed && typeof sealed === 'object') sealed.billingNotice = { charged: true, note: 'SCRIPTED REVERT: a twelfth sibling nobody told the seal about' };
    return sealed;`,
    expect: [/following the published recipe reproduces .* paid HTTP/i],
    mustName: ['billingNotice'],
    alsoAssert: {
      run: runGateV,
      staysGreen: /following the published recipe reproduces .* free MCP/i,
      because: 'the drift is on one surface only, and a gate that could not tell them apart would not say where to look',
    },
  },
];

console.log('GATE V REVERT — proving the recipe gate can fail\n');

const ORIGINAL = new Map();
for (const r of REVERTS) {
  if (!ORIGINAL.has(r.target)) ORIGINAL.set(r.target, readFileSync(r.target, 'utf8'));
  if (!ORIGINAL.get(r.target).includes(r.find)) {
    console.error(`The code this revert changes is no longer in ${r.target}:\n  ${r.name}`);
    console.error(`  missing literal: ${r.find.slice(0, 110).replace(/\n/g, ' ')}…`);
    console.error('Refusing to run: a revert that does not apply would report a meaningless result.');
    process.exit(2);
  }
}
const restoreAll = () => { for (const [f, s] of ORIGINAL) writeFileSync(f, s); };

const baseline = runGateV();
console.log(`  baseline gate V: ${baseline.pass} pass, ${baseline.fail} fail`);
if (baseline.fail !== 0 || baseline.pass === 0) {
  console.error('  Not green before any revert, so nothing below would mean anything.');
  process.exit(2);
}

const results = [];
try {
  for (const r of REVERTS) {
    writeFileSync(r.target, ORIGINAL.get(r.target).replace(r.find, r.replace));
    const out = runGateV();
    console.log(`\n  revert: ${r.name}`);
    console.log(`    gate V against reverted code : ${out.pass} pass, ${out.fail} fail`);
    for (const n of out.failedNames) console.log(`      RED: ${n}`);

    const wentRed = r.expect.every((e) => out.failedNames.some((n) => e.test(n)));
    const named = r.mustName.filter((s) => out.out.includes(s));
    console.log(`    names the key it is about      : ${named.length}/${r.mustName.length} [${named.join(', ')}]`);

    let blind = null;
    if (r.alsoAssert) {
      const o2 = r.alsoAssert.run();
      const stillGreen = !o2.failedNames.some((n) => r.alsoAssert.staysGreen.test(n));
      blind = { stillGreen, detail: `${o2.pass} pass, ${o2.fail} fail` };
      console.log(`    companion check stays green    : ${stillGreen ? 'YES' : 'NO'} (${blind.detail})`);
      console.log(`      because ${r.alsoAssert.because}`);
    }

    results.push({ name: r.name, wentRed, fullyNamed: named.length === r.mustName.length, blindOk: !r.alsoAssert || blind.stillGreen });
    restoreAll();
  }
} finally {
  restoreAll();
}

const restored = runGateV();
console.log(`\n  restored gate V: ${restored.pass} pass, ${restored.fail} fail`);

console.log('\nRESULT');
let ok = restored.fail === 0 && restored.pass === baseline.pass;
for (const r of results) {
  const good = r.wentRed && r.fullyNamed && r.blindOk;
  ok = ok && good;
  console.log(`  [${good ? 'OK' : '*** BAD ***'}] ${r.name}`);
  if (!r.wentRed) console.log('        the gate did NOT go red on the check that owns this defect');
  if (!r.fullyNamed) console.log('        the gate went red without naming the key — not an actionable failure');
  if (!r.blindOk) console.log('        the companion check did not stay green, so the blind spot is not what this script claims');
}
console.log(`  [${restored.fail === 0 && restored.pass === baseline.pass ? 'OK' : '*** BAD ***'}] the files are restored and gate V is green again`);
process.exit(ok ? 0 : 1);
