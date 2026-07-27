// The documents must agree with each other and with the running system.
//
// This test exists because they repeatedly did not, and because every previous fix was a manual
// sweep that missed something. The last round is representative: the machine edition grew from six
// parts to seven, six places were updated, and the submission's list of part URLs — the one a judge
// actually clicks — still stopped at /paper/6. A human found it. That is the wrong instrument.
//
// The tool it runs reads the facts from the system (engine build id, service count, part files on
// disk, the deployment record) and holds every PUBLISHED document to them, while leaving dated logs
// alone because a log is supposed to say what was true when it was written.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('every published document agrees with the running system', () => {
  const tool = fileURLToPath(new URL('../tools/docs-consistency.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [tool], { encoding: 'utf8' });
  // The tool prints the contradictions it found; surfacing that output verbatim is the point, because
  // "docs are inconsistent" without the list is a failure a reader cannot act on.
  assert.equal(r.status, 0, `\n${r.stdout || ''}${r.stderr || ''}`);
});
