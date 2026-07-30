// Interrupt safety for the scripted-revert harness.
//
// A revert script proves a gate can fail by writing a defect into a real file, running the gate, and
// putting the file back. The restore lives in a `finally`, and a `finally` does not run when the process
// is killed: measured on this box, a node process holding a patched file and killed with SIGTERM leaves
// the file patched. One full gateAT-revert run takes ~320s (the gate alone is 45.6s and is run seven
// times), so it is longer than the 120s default tool timeout and being killed is the NORMAL case.
//
// That alone is recoverable. What makes it permanent is the second run: the old code copied the target
// over the backup before checking anything, so an interrupted run's pristine backup was destroyed by the
// next attempt, and the `finally` then restored the patched copy. That happened twice, once to
// src/util/repair.js and src/util/routing.js (recorded in docs/elapsedms.md 6.5) and once to
// gateAT-attest-no-snark.mjs, and both times the only surviving pristine copy was the committed mirror.
//
// So the invariants here are:
//
//   1. A BACKUP ON DISK IS EVIDENCE, NOT GARBAGE. It is never overwritten. If one exists, either another
//      run owns it or a dead run abandoned it, and those are different situations.
//   2. TELL A LIVE SIBLING FROM A DEAD ONE. The lock records the pid. A live pid means refuse; a dead pid
//      means restore from the backup we found. This matters because these scripts genuinely do run
//      concurrently (gateMR-revert was mid-flight while this module was being written), and a healer that
//      cannot tell the two apart would corrupt the very run it meant to protect.
//   3. GREEN BEFORE BACKUP. Verify the target matches its committed copy FIRST. Backing up an
//      already-defective file just launders the defect into the baseline.
//   4. RESTORE ON THE WAY OUT, whichever way that is. SIGINT/SIGTERM/SIGHUP/SIGBREAK, an uncaught throw,
//      a rejected promise, and a plain exit all route through the same restore.
//
// Nothing here writes under src/engine/, and no revert script does either: the `engine/proof.js` paths in
// that harness are imports used to read the build id, which is the point of reading it on both sides.
import { readFileSync, writeFileSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const backupPath = (target) => `${target}.revert-backup`;
const lockPath = (target) => `${target}.revert-lock`;

const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

// The committed copy is the only pristine source that survived both real corruptions, so it is the
// reference. It is deliberately read out of git rather than off disk: the working file in the mirror can
// itself be mid-patch, and a reference that can be patched is not a reference.
//
// The dev tree is not a git repo — the mirror is — so `repoRoot` usually has to be given, and the path
// inside that repo is the target's path relative to the DEV root, not to the mirror.
export function committedCopy(target, { repoRoot, devRoot } = {}) {
  const root = repoRoot || path.resolve(path.dirname(target), '..', '..');
  const rel = path.relative(devRoot || root, target).split(path.sep).join('/');
  const r = spawnSync('git', ['-C', root, 'show', `HEAD:${rel}`], { encoding: 'buffer', maxBuffer: 1 << 28 });
  if (r.status !== 0) return null;
  return r.stdout;
}

// Guard one or more files for the lifetime of this process.
//
//   const g = protect([GATE], { repoRoot: MIRROR });
//   ... patch and run ...
//   g.release();          // restores, drops the backup and the lock
//
// `verifyAgainstCommitted` defaults to true and is the check the old code did too late.
export function protect(targets, { repoRoot, devRoot, verifyAgainstCommitted = true, onRestore } = {}) {
  const files = (Array.isArray(targets) ? targets : [targets]).map((t) => path.resolve(t));
  const owned = [];

  for (const target of files) {
    const bak = backupPath(target);
    const lock = lockPath(target);

    // 1 + 2. An existing backup is evidence. Whose?
    if (existsSync(bak)) {
      let holder = null;
      if (existsSync(lock)) {
        try { holder = JSON.parse(readFileSync(lock, 'utf8')); } catch { holder = null; }
      }
      if (holder && alive(holder.pid) && holder.pid !== process.pid) {
        for (const o of owned) o.undo();
        throw new Error(
          `${path.basename(target)}: a backup and a LIVE lock (pid ${holder.pid}, started ${holder.startedAt}) are `
          + 'already present. Another revert run owns this file. Refusing to start rather than clobber it.',
        );
      }
      // No holder, or a dead one: an interrupted run. The backup is the pristine copy, so restore FROM it.
      const patched = existsSync(target) ? readFileSync(target) : null;
      const pristine = readFileSync(bak);
      if (!patched || sha(patched) !== sha(pristine)) {
        writeFileSync(target, pristine);
        console.log(`  [self-heal] ${path.basename(target)} was left patched by an interrupted run (pid `
          + `${holder?.pid ?? 'unknown'}, dead). Restored from its own backup.`);
      }
      rmSync(bak, { force: true });
      rmSync(lock, { force: true });
    } else if (existsSync(lock)) {
      // A lock with no backup: either a run that died between the two writes, or a stale file.
      let holder = null;
      try { holder = JSON.parse(readFileSync(lock, 'utf8')); } catch { holder = null; }
      if (holder && alive(holder.pid) && holder.pid !== process.pid) {
        for (const o of owned) o.undo();
        throw new Error(`${path.basename(target)}: a LIVE lock (pid ${holder.pid}) with no backup. Refusing to start.`);
      }
      rmSync(lock, { force: true });
    }

    // 3. Green before backup: the file we are about to snapshot must be the committed one.
    const current = readFileSync(target);
    if (verifyAgainstCommitted) {
      const ref = committedCopy(target, { repoRoot, devRoot });
      if (!ref) {
        for (const o of owned) o.undo();
        throw new Error(`${path.basename(target)}: no committed copy found to check against (repoRoot=${repoRoot || 'auto'}). `
          + 'Refusing to start: without a known-good reference an injected defect cannot be told from the real file.');
      }
      if (sha(ref) !== sha(current)) {
        for (const o of owned) o.undo();
        throw new Error(
          `${path.basename(target)} does not match its committed copy (HEAD ${sha(ref).slice(0, 12)} vs `
          + `working ${sha(current).slice(0, 12)}). Either an interrupted run left a defect in it, or it has `
          + 'uncommitted edits. Refusing to take a backup of a file that may already be defective.',
        );
      }
    }

    copyFileSync(target, backupPath(target));
    writeFileSync(lockPath(target), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), target }));
    owned.push({
      target,
      pristine: current,
      undo() {
        try { writeFileSync(target, this.pristine); } catch { /* nothing better to do while dying */ }
        try { rmSync(backupPath(target), { force: true }); } catch { /* idem */ }
        try { rmSync(lockPath(target), { force: true }); } catch { /* idem */ }
      },
    });
  }

  // 4. Every way out goes through the same restore, and it must be idempotent because a SIGINT during
  // the exit handler would otherwise run it twice.
  let done = false;
  const restoreAll = (why) => {
    if (done) return;
    done = true;
    for (const o of owned) o.undo();
    if (why) console.log(`  [revert-guard] restored ${owned.length} file(s) on ${why}.`);
    if (onRestore) { try { onRestore(why); } catch { /* ignore */ } }
  };

  const onSignal = (sig) => () => { restoreAll(sig); process.exit(sig === 'SIGINT' ? 130 : 143); };
  const handlers = [];
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    const h = onSignal(sig);
    handlers.push([sig, h]);
    try { process.on(sig, h); } catch { /* SIGBREAK is win32-only, SIGHUP is not */ }
  }
  const onFatal = (kind) => (err) => {
    restoreAll(kind);
    console.error(err?.stack || String(err));
    process.exit(1);
  };
  const hUncaught = onFatal('uncaughtException');
  const hReject = onFatal('unhandledRejection');
  process.on('uncaughtException', hUncaught);
  process.on('unhandledRejection', hReject);
  const hExit = () => restoreAll(null);
  process.on('exit', hExit);

  return {
    files,
    pristineOf: (t) => owned.find((o) => o.target === path.resolve(t))?.pristine,
    restore: () => { for (const o of owned) { try { writeFileSync(o.target, o.pristine); } catch { /* ignore */ } } },
    release() {
      restoreAll(null);
      for (const [sig, h] of handlers) { try { process.off(sig, h); } catch { /* ignore */ } }
      process.off('uncaughtException', hUncaught);
      process.off('unhandledRejection', hReject);
      process.off('exit', hExit);
    },
  };
}

export { backupPath, lockPath, alive };
