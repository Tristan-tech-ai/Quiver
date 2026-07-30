// Find and repair working trees left damaged by an interrupted scripted-revert run.
//
// WHY THIS EXISTS AND NOT JUST A SIGNAL HANDLER. The obvious fix for "a killed revert leaves a defect in
// the file" is to restore from a signal handler. On this platform that is not available. Measured with
// node v24.11.1 on win32: `child.kill('SIGTERM')`, `('SIGINT')` and `('SIGBREAK')` all report exit code
// null and run NO handler — not the signal handler, not even the `process.on('exit')` hook. Node maps them
// to TerminateProcess. So an interrupted run cannot clean up after itself here, and the only defence that
// can work is one that runs LATER. That is this script.
//
// It matters because a full run is longer than the tool timeout that kills it: gateAT-attest-no-snark.mjs
// takes 45.6s measured, gateAT-revert runs it seven times, so ~320s against a 120s default. Being killed
// is the normal case, not the exception.
//
// WHAT IT LOOKS FOR
//   1. Leftover artefacts: *.revert-backup, *.revert-lock, *.naive-backup.
//   2. Any tracked file that differs from the mirror's HEAD *and* carries a scripted-defect marker.
//
// Condition 2 is deliberately narrow. "Differs from HEAD" alone is normal — this tree always has real
// uncommitted work in it — so healing on that alone would destroy legitimate edits. The marker is what
// distinguishes an injected defect from a hand-written change.
//
// WHAT IT REFUSES TO DO. It will not heal while a *-revert.mjs process is alive. Those scripts genuinely
// run concurrently (gateMR-revert.mjs was mid-flight while this was written, and a marker was caught in
// gateAT-attest-no-snark.mjs during one scan and gone from it seconds later), and a healer that cannot
// tell a live patch from abandoned wreckage would corrupt the run it meant to protect.
//
//   node zk/scripts/revert-heal.mjs            report only
//   node zk/scripts/revert-heal.mjs --heal     repair what is safely repairable
import { readFileSync, writeFileSync, existsSync, rmSync, globSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { alive } from './lib/revert-guard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEV = path.resolve(HERE, '..', '..');
// In the dev tree the git repo is the Quiver/ mirror beside us. In a CLONE this file already lives inside
// the repo, so there is no Quiver/Quiver, and hardcoding one would make every `git show` fail, return null
// for every file, and report a clean tree having checked nothing. That is the shape of vacuous pass this
// whole script exists to prevent, so the repo root is located rather than assumed.
const MIRROR = existsSync(path.join(DEV, 'Quiver', '.git')) ? path.join(DEV, 'Quiver')
  : existsSync(path.join(DEV, '.git')) ? DEV
    : (() => {
      const r = spawnSync('git', ['-C', HERE, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
      return r.status === 0 ? r.stdout.trim() : path.join(DEV, 'Quiver');
    })();
const HEAL = process.argv.includes('--heal');

const sha = (b) => createHash('sha256').update(b).digest('hex');
const MARKER = /SCRIPTED (REVERT|DEFECT)/;

// Working path -> path inside the git repo. In the dev tree the mirror is the service root, so
// hackathon/veritape/ maps onto its top level while zk/ keeps its name. In a clone the file is already
// inside the repo and the path needs no translation at all, which the first version got wrong: every
// top-level `gates/…` and `src/…` came back null and was silently skipped.
const INSIDE_REPO = path.resolve(MIRROR) === path.resolve(DEV);
const toMirrorRel = (abs) => {
  const rel = path.relative(DEV, abs).split(path.sep).join('/');
  if (rel.startsWith('..')) return null;
  if (INSIDE_REPO) return rel;
  if (rel.startsWith('hackathon/veritape/')) return rel.slice('hackathon/veritape/'.length);
  if (rel.startsWith('Quiver/')) return rel.slice('Quiver/'.length);
  if (rel.startsWith('zk/')) return rel;
  return null;
};

const atHead = (rel) => {
  const r = spawnSync('git', ['-C', MIRROR, 'show', `HEAD:${rel}`], { encoding: 'buffer', maxBuffer: 1 << 28 });
  return r.status === 0 ? r.stdout : null;
};

const SELF = path.basename(fileURLToPath(import.meta.url));

// Is any revert script running right now? If so we only report.
//
// This script's own name contains "revert", so the first version of it reported ITSELF as a running revert
// script and suppressed its own repairs. Excluded by name here.
const runningReverts = () => {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object -ExpandProperty CommandLine"],
    { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0 || !r.stdout) return [];
  return [...new Set(
    r.stdout.split('\n')
      .filter((l) => /revert[\w.-]*\.mjs/.test(l))
      .map((l) => (l.match(/[\w.-]*revert[\w.-]*\.mjs/) || ['?'])[0])
      .filter((n) => n !== SELF && n !== 'revert-guard.mjs'),
  )];
};

// A revert script is the AUTHOR of scripted-defect markers, never a victim of one: the marker text lives
// in its patch table as data. So "carries a marker and differs from HEAD" is true of any revert script
// that is simply being edited, and the first run of this healer flagged gateAT-revert.mjs itself for that
// reason — with --heal it would have reverted the very fix being written. They are excluded, and the
// exclusion is by role, not by a hardcoded name list.
const isRevertAuthor = (abs) => /revert[\w.-]*\.mjs$/.test(path.basename(abs))
  || path.basename(abs) === 'revert-guard.mjs'
  || path.basename(abs) === 'gateAT-guard-selftest.mjs';

// Both layouts are listed and missing ones are skipped, so the same script works in the dev tree and in a
// clone. The bare names are the clone's top level; they are also harmless in the dev tree, where they do
// not exist.
const SEARCH = [
  'zk/scripts', 'zk/circuits', 'zk/build',
  'hackathon/veritape/gates', 'hackathon/veritape/src', 'hackathon/veritape/assets', 'hackathon/veritape/docs',
  'Quiver/gates', 'Quiver/src', 'Quiver/zk/scripts', 'Quiver/docs', 'Quiver/assets',
  'gates', 'src', 'docs', 'assets',
];

console.log(`REVERT HEAL — ${HEAL ? 'REPAIR' : 'report only'} — ${new Date().toISOString()}`);
const live = runningReverts();
if (live.length) {
  console.log(`  ${live.length} revert script(s) appear to be RUNNING: ${live.join(', ')}`);
  console.log('  Anything they are holding is in-flight, not wreckage. Repair is suppressed for locked files.');
}

const artefacts = [];
for (const dir of SEARCH) {
  const base = path.join(DEV, dir);
  if (!existsSync(base)) continue;
  for (const pat of ['**/*.revert-backup', '**/*.revert-lock', '**/*.naive-backup']) {
    for (const f of globSync(pat, { cwd: base })) artefacts.push(path.join(base, f));
  }
}

const injected = [];
// Coverage counters. "0 injected defects" is the answer we hope for and also exactly what a broken scan
// returns, so the two are separated: `scanned` is how many files were read at all, and `comparable` is how
// many were actually resolved to a HEAD blob and compared. A run where `comparable` is 0 has concluded
// nothing and must not be allowed to report a clean tree.
let scanned = 0;
let comparable = 0;
let unresolved = 0;
for (const dir of SEARCH) {
  const base = path.join(DEV, dir);
  if (!existsSync(base)) continue;
  for (const f of globSync('**/*.{js,mjs,circom,json,md,html}', { cwd: base })) {
    const abs = path.join(base, f);
    if (isRevertAuthor(abs)) continue;
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (!st.isFile() || st.size > (1 << 24)) continue;
    let body;
    try { body = readFileSync(abs); } catch { continue; }
    scanned++;
    const rel = toMirrorRel(abs);
    const head = rel ? atHead(rel) : null;
    if (head) comparable++; else { unresolved++; continue; }
    if (!MARKER.test(body.toString('utf8'))) continue;
    // Marker present AND differs from HEAD. A revert script legitimately contains the marker as data, and
    // those are excluded by role above; anything else carrying one and diverging from HEAD is a defect.
    if (sha(head) !== sha(body)) injected.push({ abs, rel, head });
  }
}

console.log('');
console.log(`  repo used as the pristine reference : ${path.relative(DEV, MIRROR) || '.'} (${INSIDE_REPO ? 'running inside it' : 'mirror beside the dev tree'})`);
console.log(`  files read : ${scanned}   compared against HEAD : ${comparable}   unresolved : ${unresolved}`);
// A floor, not a note. Below this the scan has not looked at the tree in any meaningful way, and a clean
// report would be a statement about nothing. Chosen against the measured population: this tree resolves
// well over a thousand files, so 50 is far below any healthy run and far above zero.
const COVERAGE_FLOOR = 50;
const vacuous = comparable < COVERAGE_FLOOR;
if (vacuous) {
  console.log(`\n  *** ONLY ${comparable} FILE(S) COULD BE COMPARED AGAINST HEAD (floor ${COVERAGE_FLOOR}).`);
  console.log(`  *** NOT ENOUGH COVERAGE TO CONCLUDE ANYTHING. The reference repo at ${MIRROR}`);
  console.log('  *** is probably wrong or has no HEAD, so a clean result here would mean nothing.');
}
console.log('');
console.log(`  leftover artefacts (.revert-backup / .revert-lock / .naive-backup) : ${artefacts.length}`);
for (const a of artefacts) console.log(`      ${path.relative(DEV, a)}`);
console.log(`  files carrying a scripted-defect marker AND differing from HEAD   : ${injected.length}`);
for (const i of injected) console.log(`      ${path.relative(DEV, i.abs)}`);

let repaired = 0;
let skipped = 0;

if (HEAL) {
  console.log('\n  repairing:');
  for (const i of injected) {
    const lock = `${i.abs}.revert-lock`;
    if (existsSync(lock)) {
      let holder = null;
      try { holder = JSON.parse(readFileSync(lock, 'utf8')); } catch { holder = null; }
      if (holder && alive(holder.pid)) {
        console.log(`      [skip] ${path.basename(i.abs)} — LIVE lock, pid ${holder.pid} owns it`);
        skipped++;
        continue;
      }
    }
    if (live.length && !existsSync(`${i.abs}.revert-backup`)) {
      // A marker with no backup and revert scripts running: cannot prove it is abandoned.
      console.log(`      [skip] ${path.basename(i.abs)} — revert scripts are running and this file has no lock/backup to prove it is abandoned`);
      skipped++;
      continue;
    }
    writeFileSync(i.abs, i.head);
    rmSync(`${i.abs}.revert-backup`, { force: true });
    rmSync(lock, { force: true });
    console.log(`      [healed] ${path.relative(DEV, i.abs)} <- mirror HEAD:${i.rel}`);
    repaired++;
  }

  // Artefacts whose target is already clean are just litter, but a backup is only litter once its target
  // matches HEAD. Checked, not assumed.
  for (const a of artefacts) {
    const target = a.replace(/\.(revert-backup|revert-lock|naive-backup)$/, '');
    const rel = toMirrorRel(target);
    const head = rel ? atHead(rel) : null;
    const cur = existsSync(target) ? readFileSync(target) : null;
    const lock = `${target}.revert-lock`;
    let holder = null;
    if (existsSync(lock)) { try { holder = JSON.parse(readFileSync(lock, 'utf8')); } catch { holder = null; } }
    if (holder && alive(holder.pid)) { console.log(`      [skip] ${path.basename(a)} — LIVE lock, pid ${holder.pid}`); skipped++; continue; }
    if (head && cur && sha(head) === sha(cur)) {
      rmSync(a, { force: true });
      console.log(`      [dropped] ${path.relative(DEV, a)} — its target already matches HEAD`);
      repaired++;
    } else {
      console.log(`      [kept] ${path.relative(DEV, a)} — target does not match HEAD, so this backup may be the only pristine copy`);
      skipped++;
    }
  }
  if (!injected.length && !artefacts.length) console.log('      nothing to repair');
}

const outstanding = HEAL ? (injected.length + artefacts.length - repaired) : (injected.length + artefacts.length);
console.log('');
if (vacuous) {
  console.log(`REVERT HEAL: INCONCLUSIVE — only ${comparable} file(s) compared against HEAD (floor ${COVERAGE_FLOOR}). `
    + 'Fix the reference repo before trusting any result from this script.');
  process.exit(2);
}
if (outstanding === 0) {
  console.log(`REVERT HEAL: tree is clean over ${comparable} compared file(s) — no injected defect and no abandoned backup.`);
} else if (!HEAL) {
  console.log(`REVERT HEAL: ${outstanding} item(s) need attention. Re-run with --heal to repair.`);
} else {
  console.log(`REVERT HEAL: repaired ${repaired}, ${skipped} left alone (live or unprovable).`);
}
process.exit(outstanding === 0 || (HEAL && outstanding === skipped) ? 0 : 1);
