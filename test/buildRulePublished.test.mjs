// `/build` published a hash and not the rule that produced it. That is not a theoretical gap — it is
// one this project walked into: the walk over the engine sources changed from flat to recursive, and
// every verifier holding its own copy of the old rule went stale and began reporting a mismatch
// against a correct build. A reader hitting that cannot tell "the code changed" from "my recipe is
// out of date", and the first reading is the alarming one.
//
// These tests FAIL on the pre-fix handler, which published no rule at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import app from '../src/app.js';
import { _internal } from '../src/engine/proof.js';

const ENGINE = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'engine');

async function getBuild() {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/build`);
    return await res.json();
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('/build publishes the rule, not just the hash', async () => {
  const b = await getBuild();
  assert.ok(b.hashRule, 'a hash without its rule cannot tell a stale verifier from changed code');
  for (const k of ['root', 'select', 'key', 'entry', 'join', 'digest', 'fileCount', 'files']) {
    assert.ok(k in b.hashRule, `hashRule.${k} is missing`);
  }
  assert.match(b.hashRule.select, /RECURSIV/i, 'the recursive walk is the part that went stale — it must be stated');
});

test('the published rule, followed literally, reproduces the published hash', async () => {
  // The point of the whole finding: a reader who implements exactly what /build says must land on
  // exactly what /build serves. This test implements it from the response fields alone.
  const b = await getBuild();
  const joined = b.hashRule.files
    .map((rel) => `${rel}:${readFileSync(join(ENGINE, rel), 'utf8')}`)
    .join('\n');
  const recomputed = 'q1-' + createHash('sha256').update(joined).digest('hex').slice(0, 16);
  assert.equal(recomputed, b.codeHash, 'the published rule must produce the published hash');
  assert.equal(recomputed, _internal.buildId(), 'and both must equal what the engine computes');
});

test('the file list is the real one, and includes the subtree that used to be invisible', async () => {
  const b = await getBuild();
  assert.equal(b.hashRule.fileCount, b.hashRule.files.length);
  assert.ok(b.hashRule.files.some((f) => f.startsWith('chart/')),
    'the nested engine sources are exactly what the old flat rule missed; they must appear here');
  assert.deepEqual([...b.hashRule.files].sort(), b.hashRule.files, 'files must be sorted, as the rule claims');
});

test('the note tells a reader how to read a mismatch', async () => {
  const b = await getBuild();
  assert.match(b.hashRule.note, /recipe is out of date/i,
    'the failure mode this exists to prevent must be named in the response');
});
