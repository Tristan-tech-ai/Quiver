// REVERT PROOF for section 4 of gate-clone-portability.mjs — the HEAD checks.
//
// Section 1's harness breaks the WORKING TREE, and that is exactly why section 4 needs its own: a
// mutation of the working tree cannot make a claim about HEAD go red. So this one clones the repository
// into a scratch directory, commits a deliberate defect there, and points the gate at that clone with
// QUIVER_HEAD_REPO. The real repository is never touched, nothing is staged in it, and no commit in it is
// amended — a scratch clone is the only safe way to author a broken commit in a tree five sessions share.
//
// The first mutation is not invented. On 29 July a session wrote `src/util/lpBoundedness.js`, committed
// the `src/services.js` that imports it, and never committed the module; a clone of `origin/main` died on
// ERR_MODULE_NOT_FOUND before serving a request, for two commits, and nothing in the repository could go
// red. Mutation 1 deletes that same module and commits the deletion, which is byte-for-byte the state the
// repository was actually published in.
//
//   node zk/scripts/revert-clone-portability-section4.mjs      (npm run gate:clone-revert4 in zk/)
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoRoot } from './head-tree.mjs';

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const ZK = path.join(SCRIPTS, '..');
const GATE = path.join(SCRIPTS, 'gate-clone-portability.mjs');
const START = 'The repository at HEAD (git), not the working tree';
const MARKER = 'Running each gate from the repository root';

/** Run the gate against `repo` and return section 4 only. */
function section4(repo) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [GATE], {
      cwd: path.join(ZK, '..'),
      env: { ...process.env, QUIVER_HEAD_REPO: repo },
    });
    let buf = '';
    const done = () => resolve(buf.includes(START) ? buf.split(START)[1].split(MARKER)[0].trimEnd() : `(section 4 never printed)\n${buf}`);
    child.stdout.on('data', (d) => { buf += d; if (buf.includes(MARKER)) { child.kill(); done(); } });
    child.stderr.on('data', (d) => { buf += d; });
    child.on('close', done);
  });
}

const git = (repo, args) => {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${repo}: ${r.stderr || r.stdout}`);
  return r.stdout;
};

// Committing in the scratch clone needs an identity and must not inherit a signing configuration that
// would open a prompt. Set locally, in the clone, never globally.
function scratchClone(source) {
  const dir = mkdtempSync(path.join(tmpdir(), 'quiver-revert4-'));
  const repo = path.join(dir, 'clone');
  const r = spawnSync('git', ['clone', '--quiet', '--no-hardlinks', source, repo], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`could not clone ${source}: ${r.stderr}`);
  git(repo, ['config', 'user.email', 'revert-harness@localhost']);
  git(repo, ['config', 'user.name', 'revert harness']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  return { dir, repo };
}

const MUTATIONS = [
  {
    name: 'commit the deletion of src/util/lpBoundedness.js — the 29 July defect verbatim: a committed '
        + 'src/services.js importing a module that is in no commit',
    apply: (repo) => {
      git(repo, ['rm', '--quiet', 'src/util/lpBoundedness.js']);
      git(repo, ['commit', '--quiet', '-m', 'scratch: remove a module that a committed file imports']);
    },
    expect: [/\*\*\* FAIL \*\*\*\] no file committed at HEAD imports a module that is absent from HEAD/,
             /src\/services\.js:\d+ imports \.\/util\/lpBoundedness\.js/],
  },
  {
    name: 'commit the deletion of zk/build/liquidation.r1cs — an artifact that is on this disk and would '
        + 'no longer be in the repository, the exact shape of the five that were missing until 30 July',
    apply: (repo) => {
      git(repo, ['rm', '--quiet', 'zk/build/liquidation.r1cs']);
      git(repo, ['commit', '--quiet', '-m', 'scratch: remove a required artifact from the repository']);
    },
    expect: [/\*\*\* FAIL \*\*\*\] every artifact a gate needs is committed at HEAD/,
             /build\/liquidation\.r1cs/],
  },
  {
    name: 'commit a package.json with the gate:lb aliases removed — a command four documents tell a '
        + 'reader to run and the manifest does not define',
    apply: (repo) => {
      const p = path.join(repo, 'package.json');
      const pkg = JSON.parse(readFileSync(p, 'utf8'));
      delete pkg.scripts['gate:lb'];
      delete pkg.scripts['gate:lb-revert'];
      writeFileSync(p, `${JSON.stringify(pkg, null, 2)}\n`);
      git(repo, ['commit', '--quiet', '-m', 'scratch: publish a document naming a script the manifest lacks', '--', 'package.json']);
    },
    expect: [/\*\*\* FAIL \*\*\*\] every `npm run` a committed document publishes is defined in a committed manifest/,
             /npm run gate:lb/],
  },
  {
    name: 'commit a copy of assets/zk/kelly_plonk.zkey that differs from zk/build/kelly_plonk.zkey — the '
        + 'service proving against one key while every gate verifies the other',
    apply: (repo) => {
      const p = path.join(repo, 'assets', 'zk', 'kelly_plonk.zkey');
      const b = readFileSync(p);
      b[b.length - 1] ^= 0xff;                 // one byte, so it is a divergence and not a different file
      writeFileSync(p, b);
      git(repo, ['commit', '--quiet', '-m', 'scratch: let the served key drift from the verified key', '--', 'assets/zk/kelly_plonk.zkey']);
    },
    expect: [/\*\*\* FAIL \*\*\*\] where an artifact is committed twice, the two copies are byte-identical at HEAD/,
             /kelly_plonk\.zkey/],
  },
];

const { repo: SOURCE, head: SOURCE_HEAD } = repoRoot();
console.log('REVERT PROOF — section 4 of gate-clone-portability.mjs (the HEAD checks)\n');
console.log(`source repository: ${SOURCE}\nsource HEAD:       ${SOURCE_HEAD}\n`);

console.log('BASELINE — a clean clone of that repository, nothing broken:');
const clean = scratchClone(SOURCE);
let base;
try { base = await section4(clean.repo); } finally { /* kept until the end so the printout can be read */ }
console.log(base.split('\n').map((l) => `  ${l}`).join('\n'));
const baselineGreen = !base.includes('*** FAIL ***') && base.includes('[PASS] no file committed at HEAD imports');
console.log(`\n  baseline is green: ${baselineGreen}\n`);
rmSync(clean.dir, { recursive: true, force: true });

let allWentRed = true;
for (const m of MUTATIONS) {
  console.log(`${'-'.repeat(100)}\nMUTATION: ${m.name}`);
  const scratch = scratchClone(SOURCE);
  let out;
  try {
    m.apply(scratch.repo);
    out = await section4(scratch.repo);
  } finally {
    rmSync(scratch.dir, { recursive: true, force: true });
  }
  // Both halves matter: the right check has to go red AND it has to NAME the thing that broke, because a
  // red gate that does not say what is wrong sends a reader to read the gate instead of the repository.
  const red = m.expect.every((rx) => rx.test(out));
  if (!red) allWentRed = false;
  console.log(out.split('\n').filter((l) => /FAIL|imports|missing|not at HEAD|npm run|differ/.test(l)).slice(0, 6).map((l) => `  ${l}`).join('\n') || '  (no failure line at all)');
  console.log(`\n  => went red and named it: ${red ? 'YES' : 'NO — THE CHECK CANNOT FAIL'}`);
}

console.log(`\n${'='.repeat(100)}`);
console.log(`REVERT PROOF: ${baselineGreen && allWentRed
  ? 'PASSED — section 4 is green against a clean clone and red, by name, for every commit above'
  : 'FAILED — see above'}`);
process.exit(baselineGreen && allWentRed ? 0 : 1);
