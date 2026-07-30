// Does the interrupt guard actually hold? Four scenarios, none of which need the 45.6s gate to run.
//
// The guard exists because a `finally` does not survive SIGTERM (measured: a node process holding a
// patched file and killed with SIGTERM leaves it patched), and because the old harness destroyed the one
// pristine backup an interrupted run left behind. So the scenarios are the four states the file system
// can actually be in, and each one asserts on the CONTENT of the target afterwards, not on an exit code.
//
//   node zk/scripts/gateAT-guard-selftest.mjs
import { readFileSync, writeFileSync, existsSync, rmSync, mkdtempSync, mkdirSync } from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { protect, backupPath, lockPath } from './lib/revert-guard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// A file:// URL, not a bare path: on win32 `import 'C:/…'` throws, and the first run of this selftest
// silently passed scenario 2 because the child died on that import before it ever patched anything. The
// mid-flight assertion below is what exposed it, which is the only reason it is written that way.
const GUARD = pathToFileURL(path.join(HERE, 'lib', 'revert-guard.mjs')).href;
const PRISTINE = 'PRISTINE CONTENT\nline two\n';
const PATCHED = 'PRISTINE CONTENT\n// SCRIPTED REVERT: injected\n';

let fails = 0;
const check = (name, ok, detail) => {
  console.log(`  [${ok ? 'ok' : '*** FAIL ***'}] ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) fails++;
};

// A throwaway git repo so committedCopy() has a real HEAD to read, rather than a stub that would let the
// verify step pass for the wrong reason.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'revert-guard-'));
const repo = path.join(tmp, 'repo');
mkdirSync(path.join(repo, 'zk', 'scripts'), { recursive: true });
const target = path.join(repo, 'zk', 'scripts', 'victim.mjs');
writeFileSync(target, PRISTINE);
const git = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
git('init', '-q');
git('config', 'user.email', 'selftest@local');
git('config', 'user.name', 'selftest');
git('add', 'zk/scripts/victim.mjs');
git('commit', '-qm', 'pristine');
const head = git('show', 'HEAD:zk/scripts/victim.mjs');
if (head.status !== 0 || head.stdout !== PRISTINE) {
  console.log('  [*** FAIL ***] the fixture repo does not have the pristine file at HEAD — nothing below would mean anything');
  process.exit(1);
}

console.log(`GATE AT GUARD SELFTEST — ${new Date().toISOString()}`);
console.log(`  fixture repo: ${repo}\n`);

// ---------------------------------------------------------------- 1. the happy path
console.log('1. clean start, patch, release');
{
  const g = protect([target], { repoRoot: repo, devRoot: repo });
  const hadBackup = existsSync(backupPath(target));
  const hadLock = existsSync(lockPath(target));
  writeFileSync(target, PATCHED);
  check('backup taken', hadBackup);
  check('lock written', hadLock);
  check('patch landed', readFileSync(target, 'utf8') === PATCHED);
  g.release();
  check('restored on release', readFileSync(target, 'utf8') === PRISTINE);
  check('backup removed', !existsSync(backupPath(target)));
  check('lock removed', !existsSync(lockPath(target)));
}

// ---------------------------------------------------------------- 2. SIGTERM mid-patch
// This is the case the `finally` lost. A child takes the guard, patches, and announces; we kill it with
// SIGTERM and require the file to be pristine anyway.
console.log('\n2. SIGTERM while the file is patched (the case a `finally` loses)');
{
  // The child must hang for real. `await new Promise(() => {})` does NOT hang on Node 24: it is detected
  // as an unsettled top-level await and the process exits by itself, which made the first version of this
  // scenario measure Node's own exit path instead of SIGTERM. A live interval is an honest hang.
  const runner = path.join(tmp, 'child.mjs');
  writeFileSync(runner, [
    `import { writeFileSync } from 'node:fs';`,
    `import { protect } from '${GUARD}';`,
    `const g = protect([${JSON.stringify(target)}], { repoRoot: ${JSON.stringify(repo)}, devRoot: ${JSON.stringify(repo)} });`,
    `writeFileSync(${JSON.stringify(target)}, ${JSON.stringify(PATCHED)});`,
    `console.log('PATCHED');`,
    `setInterval(() => {}, 1000);`,
  ].join('\n'));

  const verdict = await new Promise((resolve) => {
    const child = spawn(process.execPath, [runner], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let killed = false;
    child.stderr.on('data', (d) => { err += d; });
    child.stdout.on('data', (d) => {
      out += d;
      if (!killed && out.includes('PATCHED')) {
        killed = true;
        // Confirm the on-disk state really was patched before the kill, so a pass cannot come from the
        // child having never patched at all.
        const midflight = readFileSync(target, 'utf8');
        child.kill('SIGTERM');
        child.on('exit', () => resolve({ midflight, err }));
      }
    });
    child.on('exit', () => { if (!killed) resolve({ midflight: null, err }); });
  });

  check('the file really was patched mid-flight', verdict.midflight === PATCHED,
    `saw ${JSON.stringify(verdict.midflight)}; stderr: ${verdict.err.trim().split('\n').slice(-3).join(' / ').slice(0, 200) || '(silent)'}`);

  const after = readFileSync(target, 'utf8');
  const bakAfter = existsSync(backupPath(target));
  const lockAfter = existsSync(lockPath(target));

  if (process.platform === 'win32') {
    // Measured on this box (node v24.11.1, win32): child.kill('SIGTERM'), ('SIGINT') and ('SIGBREAK')
    // all report exit code null and run NO handler at all, not even the 'exit' hook. Node maps them to
    // TerminateProcess, so nothing in-process can restore the file. The suggestion to "install
    // SIGINT/SIGTERM handlers that restore before exiting" is therefore unavailable here, and claiming
    // this scenario green would be exactly the kind of check that cannot fail.
    //
    // So the contract on win32 is not "the file survives". It is "the wreckage is RECOVERABLE": the
    // patched file is still there, but the pristine backup and the owning lock both survive with it, and
    // the next run heals from them instead of destroying them. That is asserted here and then proved.
    check('win32: the kill is unsurvivable, so the file IS left patched (platform limit, stated not hidden)',
      after === PATCHED, `on disk: ${JSON.stringify(after.slice(0, 40))}`);
    check('but the pristine backup SURVIVED as recoverable evidence', bakAfter
      && readFileSync(backupPath(target), 'utf8') === PRISTINE);
    check('and the owning lock survived, naming the dead pid', lockAfter);

    // The actual defence, end to end: a fresh run over that wreckage must heal it.
    let threw = null;
    let g2 = null;
    try { g2 = protect([target], { repoRoot: repo, devRoot: repo }); } catch (e) { threw = e; }
    check('a FRESH run heals the interrupted one instead of refusing', !threw, threw?.message?.slice(0, 90));
    check('file is pristine again after the fresh run', readFileSync(target, 'utf8') === PRISTINE);
    if (g2) g2.release();
    check('and nothing is left behind', !existsSync(backupPath(target)) && !existsSync(lockPath(target)));
  } else {
    check('SIGTERM restored the file', after === PRISTINE, `on disk: ${JSON.stringify(after.slice(0, 40))}`);
    check('no backup left behind', !bakAfter);
    check('no lock left behind', !lockAfter);
  }
}

// ---------------------------------------------------------------- 3. an abandoned run's leftovers
// Hand-build the exact wreckage a SIGKILL leaves (patched file + pristine backup + dead-pid lock) and
// require the next run to heal from the backup rather than copy the defect into it.
console.log('\n3. leftovers from a run that died without restoring (self-heal)');
{
  writeFileSync(target, PATCHED);
  writeFileSync(backupPath(target), PRISTINE);
  writeFileSync(lockPath(target), JSON.stringify({ pid: 999999, startedAt: '2026-07-30T00:00:00.000Z', target }));
  let threw = null;
  let g = null;
  try { g = protect([target], { repoRoot: repo, devRoot: repo }); } catch (e) { threw = e; }
  check('did not refuse (the holder pid is dead)', !threw, threw?.message?.slice(0, 90));
  check('healed the target from its own backup', readFileSync(target, 'utf8') === PRISTINE);
  if (g) { g.release(); check('clean after release', readFileSync(target, 'utf8') === PRISTINE && !existsSync(backupPath(target))); }
}

// ---------------------------------------------------------------- 4. a LIVE sibling owns the file
// The reason a blind healer is wrong: gateMR-revert was genuinely mid-flight while this was written, and
// healing its in-flight patch would have corrupted the run it meant to protect.
console.log('\n4. a live sibling holds the lock (must refuse, not clobber)');
{
  writeFileSync(target, PATCHED);
  writeFileSync(backupPath(target), PRISTINE);
  writeFileSync(lockPath(target), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), target }));
  // A different pid that is genuinely alive: this process's own parent is not reliable, so spawn a sleeper.
  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' });
  writeFileSync(lockPath(target), JSON.stringify({ pid: sleeper.pid, startedAt: new Date().toISOString(), target }));
  let threw = null;
  try { protect([target], { repoRoot: repo, devRoot: repo }); } catch (e) { threw = e; }
  check('refused to start', Boolean(threw), threw ? threw.message.slice(0, 70) : 'IT STARTED ANYWAY');
  check('left the live run\'s patched file alone', readFileSync(target, 'utf8') === PATCHED);
  check('left the live run\'s backup intact', existsSync(backupPath(target)) && readFileSync(backupPath(target), 'utf8') === PRISTINE);
  sleeper.kill();
  rmSync(backupPath(target), { force: true });
  rmSync(lockPath(target), { force: true });
}

// ---------------------------------------------------------------- 5. target already differs from HEAD
console.log('\n5. the target does not match its committed copy (must refuse to snapshot it)');
{
  writeFileSync(target, PATCHED);
  let threw = null;
  try { protect([target], { repoRoot: repo, devRoot: repo }); } catch (e) { threw = e; }
  check('refused to start', Boolean(threw), threw ? threw.message.slice(0, 70) : 'IT SNAPSHOTTED A DEFECTIVE FILE');
  check('did not create a backup of the defective file', !existsSync(backupPath(target)));
  writeFileSync(target, PRISTINE);
}

// ---------------------------------------------------------------- the guard must be able to fail
// Every check above passes for the guarded path. A selftest that only ever exercises the guarded path
// would not distinguish "the guard works" from "SIGTERM happens to be survivable here", so the UNGUARDED
// shape is run through scenario 2 as well and is REQUIRED to lose the file.
console.log('\n6. control: the same scenario WITHOUT the guard must leave the file patched');
{
  const naive = path.join(tmp, 'naive.mjs');
  writeFileSync(naive, [
    `import { writeFileSync, copyFileSync, rmSync, existsSync } from 'node:fs';`,
    `const T = ${JSON.stringify(target)}; const B = T + '.naive-backup';`,
    `copyFileSync(T, B);`,
    // Same honest hang as scenario 2, for the same reason: with an unsettled top-level await this control
    // would leave the file patched because Node exited, not because the `finally` failed to run, and the
    // comparison would be meaningless.
    `try {`,
    `  writeFileSync(T, ${JSON.stringify(PATCHED)});`,
    `  console.log('PATCHED');`,
    `  setInterval(() => {}, 1000);`,
    `  await new Promise((res) => setTimeout(res, 600000));`,
    `} finally {`,
    `  if (existsSync(B)) { copyFileSync(B, T); rmSync(B); }`,
    `}`,
  ].join('\n'));

  const midflight = await new Promise((resolve) => {
    const child = spawn(process.execPath, [naive], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let killed = false;
    child.stdout.on('data', (d) => {
      out += d;
      if (!killed && out.includes('PATCHED')) {
        killed = true;
        const seen = readFileSync(target, 'utf8');
        child.kill('SIGTERM');
        child.on('exit', () => resolve(seen));
      }
    });
    child.on('exit', () => { if (!killed) resolve(null); });
  });

  check('control really patched the file', midflight === PATCHED);
  const after = readFileSync(target, 'utf8');
  check('UNGUARDED shape loses the file on SIGTERM (so the guard is what fixed it)', after === PATCHED,
    after === PRISTINE ? 'the naive shape survived too — this selftest proves nothing' : 'left patched, as expected');
  // and its backup is the pristine copy the next naive run would have clobbered
  check('the abandoned backup still holds the only pristine copy', existsSync(`${target}.naive-backup`)
    && readFileSync(`${target}.naive-backup`, 'utf8') === PRISTINE);

  // 7. And this is the step that made it PERMANENT rather than merely annoying. The naive shape opens by
  // copying the target over the backup before checking anything, so the second run overwrites the one
  // pristine copy with the patched file. After that the `finally` "restores" the defect and there is
  // nothing left to recover from. Both real corruptions were only recoverable because the committed
  // mirror still held a clean copy.
  console.log('\n7. control: the naive shape\'s SECOND run destroys the pristine backup');
  {
    const before = readFileSync(`${target}.naive-backup`, 'utf8');
    check('backup is pristine going in', before === PRISTINE);
    // exactly what the old code did first: copyFileSync(TARGET, BACKUP), with the target still patched
    const second = spawnSync(process.execPath, ['-e',
      `const {copyFileSync}=require('node:fs');copyFileSync(${JSON.stringify(target)},${JSON.stringify(`${target}.naive-backup`)});`,
    ], { encoding: 'utf8' });
    check('the second run completed', second.status === 0, second.stderr?.slice(0, 80));
    const nowBak = readFileSync(`${target}.naive-backup`, 'utf8');
    check('the pristine backup is now GONE (overwritten by the patched file)', nowBak === PATCHED,
      `backup now: ${JSON.stringify(nowBak.slice(0, 40))}`);
    check('so no pristine copy survives anywhere in the working tree',
      readFileSync(target, 'utf8') === PATCHED && nowBak === PATCHED);
  }

  rmSync(`${target}.naive-backup`, { force: true });
  writeFileSync(target, PRISTINE);
}

rmSync(tmp, { recursive: true, force: true });
console.log(fails === 0
  ? `\nGUARD SELFTEST PASSED — on ${process.platform} the kill itself is `
    + `${process.platform === 'win32' ? 'UNSURVIVABLE (no handler runs), so the defence is that the wreckage stays recoverable and the next run heals it' : 'survivable and the handler restores in place'}; `
    + 'an abandoned run self-heals, a live sibling is refused, a defective target is refused, and the unguarded shape both loses the file and destroys its own backup on the second run.'
  : `\nGUARD SELFTEST FAILED — ${fails} check(s) red.`);
process.exit(fails === 0 ? 0 : 1);
