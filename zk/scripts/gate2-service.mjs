// Gate 2 — the service emits a succinct proof, opt-in and hash-neutral.
//
// Four things have to hold, and each is measured here rather than argued:
//   1. the engine hash has not moved (no documentation sweep, no re-rendered appendix)
//   2. the published Appendix C content hash is identical with and without `snark: true`
//   3. the whole suite is green, including the proof↔answer binding
//   4. cold start is measured before and after eager warming — the number, not the intention
//
// Run: node zk/scripts/gate2-service.mjs
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'hackathon', 'veritape');
const results = [];
const record = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`); };

function run(cmd, args, opts = {}) {
  return new Promise((res) => {
    const p = spawn(cmd, args, { cwd: ROOT, shell: process.platform === 'win32', ...opts });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => res({ code, out }));
  });
}

// ---- 1. the engine hash has not moved -------------------------------------------------------
const { _internal } = await load(import.meta.url, 'engine/proof.js');
const EXPECTED_BUILD = 'q1-e1fa99d08887d6cc';
record('engine hash unchanged', _internal.buildId() === EXPECTED_BUILD,
  `${_internal.buildId()} (expected ${EXPECTED_BUILD})`);

// ---- 2. asking for a proof does not change the answer ---------------------------------------
const { byName } = await load(import.meta.url, 'services.js');
const APPENDIX_C = { side: 'long', entryPrice: 64000, size: 1, leverage: 10, maintMarginRate: 0.0125 };
const plain = await byName['perp-gate'].run({ ...APPENDIX_C });
const withSnark = await byName['perp-gate'].run({ ...APPENDIX_C, snark: true });
const PUBLISHED_HASH = '8575ce5ae5bfae9cdfdfc604250f8032e4ba85fb33560386586b7538d0ab0960';
record('Appendix C content hash is identical with and without a proof',
  plain.proof.contentHash === withSnark.proof.contentHash && plain.proof.contentHash === PUBLISHED_HASH,
  `${plain.proof.contentHash}\n      == with snark: ${plain.proof.contentHash === withSnark.proof.contentHash} · == published: ${plain.proof.contentHash === PUBLISHED_HASH}`);
record('the opt-in flag does not leak into the hashed inputs',
  !('snark' in withSnark.proof.inputs) && plain.snark === undefined,
  `echoed keys: ${Object.keys(withSnark.proof.inputs).join(',')} · plain response carries no snark field: ${plain.snark === undefined}`);

// ---- 4. cold start, measured both ways ------------------------------------------------------
// Two numbers matter and they are different questions. Boot-to-serving is what a deploy costs; if
// eager warming pushed that out, the cure would be worse than the disease. Request-to-proof-ready is
// what the warming actually buys, and it is only visible on the FIRST proof a container ever builds.
const APP = join(ROOT, 'src', 'app.js');
const original = readFileSync(APP, 'utf8');
const WARM_LINE = "warmProver().catch(() => { /* proving is optional; the service must boot without it */ });";
if (!original.includes(WARM_LINE)) { record('cold start measured', false, 'the warm line is not in app.js — nothing to compare'); }
else {
  const probe = join(ROOT, '_gate2probe.mjs');
  // The probe MUST enter through app.js, because that is the only place `warmProver()` is called. An
  // earlier version of this gate imported services.js and snark.js directly, never ran the warm line
  // at all, and reported the difference between two identical cold runs as a 58ms saving. Measuring
  // the wrong process and believing the number is exactly the failure this gate exists to catch.
  writeFileSync(probe, `
import './src/app.js';
import { byName } from './src/services.js';
import { getProof } from './src/util/snark.js';
import { load } from './service-root.mjs';
const boot = Date.now() - Number(process.env.T0);
// A buyer arrives some seconds into a container's life, not at millisecond zero. Measuring at zero
// hides the whole effect, because then the import is in flight either way.
await new Promise(r => setTimeout(r, 3000));
const out = await byName['perp-gate'].run({ side:'long', entryPrice:64000, size:1, leverage:10, maintMarginRate:0.0125, snark:true });
const respond = Date.now();
const t = Date.now();
for (;;) { const r = getProof(out.proof.contentHash); if (r && r.status !== 'building') break; await new Promise(s=>setTimeout(s,10)); }
console.log(JSON.stringify({ boot, toProof: Date.now() - t }));
await globalThis.curve_bn128?.terminate();
process.exit(0);
`, 'utf8');

  const measure = async () => {
    const runs = [];
    for (let i = 0; i < 3; i++) {
      const r = await run(process.execPath, ['_gate2probe.mjs'], { env: { ...process.env, T0: String(Date.now()) } });
      const line = r.out.trim().split('\n').filter((l) => l.trim().startsWith('{')).pop();
      if (line) runs.push(JSON.parse(line));
    }
    const med = (k) => runs.map((x) => x[k]).sort((a, b) => a - b)[Math.floor(runs.length / 2)];
    return { boot: med('boot'), toProof: med('toProof'), n: runs.length };
  };

  const warm = await measure();
  writeFileSync(APP, original.replace(WARM_LINE, '// (gate2: warming disabled for measurement)'), 'utf8');
  const cold = await measure();
  writeFileSync(APP, original, 'utf8');
  try { (await import('node:fs')).unlinkSync(probe); } catch { /* already gone */ }

  const saved = cold.toProof - warm.toProof;
  record('cold start measured before and after eager warming',
    warm.n === 3 && cold.n === 3 && Number.isFinite(saved),
    `boot→serving: ${warm.boot}ms warmed vs ${cold.boot}ms unwarmed\n`
    + `      request→proof ready, first proof of the container's life: ${warm.toProof}ms warmed vs ${cold.toProof}ms unwarmed — ${saved}ms saved (medians of 3)\n`
    + `      note: the buyer's PAID response is unaffected either way — proving is off the request path`);
  record('eager warming does not delay boot', warm.boot <= cold.boot + 250,
    `${warm.boot}ms vs ${cold.boot}ms — the import is fired without being awaited, so boot must not regress`);
}

// ---- 3. the whole suite ---------------------------------------------------------------------
const suite = await run('npm', ['test']);
const m = suite.out.match(/# pass (\d+)[\s\S]*?# fail (\d+)/) || suite.out.match(/ℹ pass (\d+)[\s\S]*?ℹ fail (\d+)/);
record('full suite green', !!m && Number(m[2]) === 0 && suite.code === 0,
  m ? `${m[1]} passing, ${m[2]} failing (exit ${suite.code})` : `could not parse the suite output (exit ${suite.code})`);

const failed = results.filter((r) => !r.pass);
console.log(`\n${'='.repeat(72)}\nGATE 2: ${failed.length ? `FAILED — ${failed.map((f) => f.name).join('; ')}` : 'PASSED'}`);
process.exit(failed.length ? 1 : 0);
