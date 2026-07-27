// Every envelope this service ships carries `codeHashScope: "build — one hash over ALL engine
// sources"`. It was not. `buildId()` used a non-recursive readdir, so `src/engine/chart/` — the
// ECharts renderer and the indicator library, ~42 kB that `chartPress.js` imports directly — was
// outside the hash. That code could change without the published build identity changing, in the one
// field a caller uses to decide which code produced their answer.
//
// These tests FAIL on the pre-fix code, which never saw the subdirectory at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { engineSourceFiles, _internal } from '../src/engine/proof.js';

const ENGINE = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'engine');

test('the hashed file list reaches into engine subdirectories', () => {
  const files = engineSourceFiles(ENGINE);
  const nested = files.filter((f) => f.includes('/'));
  assert.ok(nested.length > 0, 'no nested engine source was hashed, so a whole subtree is invisible to the build identity');
  assert.ok(nested.some((f) => f.startsWith('chart/')), `chart/ must be covered; got ${JSON.stringify(nested)}`);
});

test('every .js under src/engine is covered, with none missed and none invented', () => {
  // Independent walk, written here rather than imported, so this is a second implementation and not
  // a restatement of the one under test.
  const walk = (dir, prefix = '') => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    return e.isDirectory() ? walk(join(dir, e.name), rel) : e.name.endsWith('.js') ? [rel] : [];
  });
  const expected = walk(ENGINE).sort();
  assert.deepEqual(engineSourceFiles(ENGINE), expected);
});

test('touching a nested engine source would change the published build hash', () => {
  // Recompute the hash the way buildId does, then again with one nested file's bytes perturbed. If
  // the nested file is genuinely inside the hash, the two must differ. This is the property the
  // envelope's scope string actually promises.
  const files = engineSourceFiles(ENGINE);
  const nested = files.find((f) => f.startsWith('chart/'));
  assert.ok(nested, 'precondition: a nested engine source exists');

  const hashOf = (mutate) => createHash('sha256').update(
    files.map((f) => `${f}:${f === nested ? mutate(readFileSync(join(ENGINE, f), 'utf8')) : readFileSync(join(ENGINE, f), 'utf8')}`).join('\n')
  ).digest('hex').slice(0, 16);

  const real = hashOf((s) => s);
  const perturbed = hashOf((s) => s + '\n// a comment that would be invisible to a non-recursive walk\n');
  assert.notEqual(real, perturbed, 'a change under chart/ must move the build hash');
  assert.equal('q1-' + real, _internal.buildId(), 'and the real one must be exactly what /build serves');
});
