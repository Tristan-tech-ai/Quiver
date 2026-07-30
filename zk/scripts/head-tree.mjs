// Read the REPOSITORY AT HEAD, not the directory you are standing in.
//
// WHY THIS EXISTS. `gate-clone-portability.mjs` asks "can somebody who cloned this repository run
// these gates" and answers it by looking at the working tree — `existsSync`, `readdirSync`, spawning
// each gate where it sits. In the author's tree that is the wrong subject. Every file the author has
// written but not committed is present to `existsSync` and absent from a clone, so the gate is green
// exactly where the claim is not made and red where it is. On 29 July a session wrote
// `src/util/lpBoundedness.js`, committed the `src/services.js` that imports it, and never committed the
// module: the repository at HEAD could not start at all, and nothing in the tree could go red, because
// nothing in the tree looked at HEAD.
//
// So this module answers questions about HEAD by asking git, and the gate that uses it is the first
// check in this repository whose subject is the published artifact rather than the desk it was made on.
//
// It is deliberately free of any knowledge of what the answers should be. The floors, the exclusions and
// the verdicts live in the gate; this file only reports what HEAD contains.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const ZK = path.join(SCRIPTS, '..');

/** POSIX-separated, no leading './' — the form git uses, which is the form we compare against. */
const posix = (p) => p.split(path.sep).join('/').replace(/^\.\//, '');

function git(repo, args, opts = {}) {
  return spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
}

// A file every layout of this repository has at HEAD. Resolution is not allowed to land on some
// unrelated parent repository and then report a clean bill of health over the wrong tree, which is the
// same failure `service-root.mjs` guards with its `engine/proof.js` probe.
const PROBE = 'zk/scripts/gate-clone-portability.mjs';

/**
 * Find the git repository this checkout publishes.
 *
 * Order, and it is deliberate. The CLONE layout comes first so a reader's own checkout is the fast
 * path: in a clone `zk/` sits at `<repo>/zk`, so the repository is `<zk>/..`. The author's desk is the
 * fallback: there, `zk/` is a sibling of the mirror and the repository is `<zk>/../Quiver`. An explicit
 * QUIVER_HEAD_REPO overrides both, and exists so the revert harness can point this at a scratch clone
 * it has deliberately broken.
 *
 * @returns {{ repo: string, label: string, head: string }}
 */
export function repoRoot() {
  const tried = [];
  const candidates = [];
  if (process.env.QUIVER_HEAD_REPO) candidates.push([process.env.QUIVER_HEAD_REPO, 'QUIVER_HEAD_REPO']);
  candidates.push([path.join(ZK, '..'), 'clone: <repo>/zk']);
  candidates.push([path.join(ZK, '..', 'Quiver'), "the author's desk: the mirror beside zk/"]);

  for (const [dir, label] of candidates) {
    if (!existsSync(dir)) { tried.push(`${dir} (no such directory)`); continue; }
    const top = git(dir, ['rev-parse', '--show-toplevel']);
    if (top.status !== 0) { tried.push(`${dir} (not a git repository)`); continue; }
    const repo = top.stdout.trim();
    const probe = git(repo, ['cat-file', '-e', `HEAD:${PROBE}`]);
    if (probe.status !== 0) { tried.push(`${repo} (a repository, but HEAD has no ${PROBE})`); continue; }
    const head = git(repo, ['rev-parse', 'HEAD']).stdout.trim();
    return { repo, label, head };
  }
  throw new Error(
    `Cannot find the git repository this checkout publishes. Tried:\n  ${tried.join('\n  ')}\n` +
    'This check reads HEAD rather than the working tree, so it needs the repository, not just the files.'
  );
}

/** Every path in HEAD, as a Set of POSIX paths. */
export function headFiles(repo) {
  const r = git(repo, ['ls-tree', '-r', '-z', '--name-only', 'HEAD']);
  if (r.status !== 0) throw new Error(`git ls-tree failed in ${repo}: ${r.stderr}`);
  // -z, because a path with a space or a quote is quoted and escaped in the default output and would
  // then be compared against an import specifier that is not escaped.
  return new Set(r.stdout.split('\0').filter(Boolean));
}

/**
 * Contents of many blobs at HEAD, in ONE git process. Reading 410 files one `git show` at a time costs
 * about thirty seconds on Windows; `--batch` costs one spawn.
 * @returns {Map<string,string>} path -> utf8 contents (paths git could not resolve are absent)
 */
export function headBlobs(repo, paths) {
  const list = [...paths];
  if (!list.length) return new Map();
  const r = spawnSync('git', ['-C', repo, 'cat-file', '--batch'], {
    input: list.map((p) => `HEAD:${p}`).join('\n') + '\n',
    maxBuffer: 512 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`git cat-file --batch failed in ${repo}: ${r.stderr}`);
  const buf = r.stdout;
  const out = new Map();
  let off = 0, i = 0;
  while (off < buf.length && i < list.length) {
    const nl = buf.indexOf(0x0a, off);
    if (nl < 0) break;
    const header = buf.toString('utf8', off, nl);
    off = nl + 1;
    const m = header.match(/^([0-9a-f]{40}) (\S+) (\d+)$/);
    if (!m) { i++; continue; }               // "<spec> missing" — the caller sees an absent entry
    const size = Number(m[3]);
    out.set(list[i], buf.toString('utf8', off, off + size));
    off += size + 1;                          // git writes a newline after the payload
    i++;
  }
  return out;
}

/** Blob object ids at HEAD, keyed by path. Two identical ids are two byte-identical files. */
export function headBlobIds(repo, paths) {
  const ids = new Map();
  const r = git(repo, ['ls-tree', '-r', '-z', 'HEAD']);
  if (r.status !== 0) throw new Error(`git ls-tree failed in ${repo}: ${r.stderr}`);
  const want = new Set(paths);
  for (const rec of r.stdout.split('\0')) {
    const m = rec.match(/^\d+ blob ([0-9a-f]+)\t(.+)$/);
    if (m && want.has(m[2])) ids.set(m[2], m[1]);
  }
  return ids;
}

/**
 * Blank out comments, leave everything else — including string bodies — exactly where it was.
 *
 * NOT decoration, and the FIRST version of this got it backwards. Every gate in `zk/scripts` carries a
 * long comment explaining what it exists for, and several quote a module path inside it —
 * `service-root.mjs` quotes the dev-tree path it was written to defeat. A specifier scan that reads
 * comments reports those as imports and goes red for a sentence, which trains a reader to ignore it.
 * So comments go. String bodies must STAY: the specifier IS a string body, and dropping it turned
 * `from './x.js'` into `from ''` and found 0 imports in 410 files. That version passed its own
 * unresolved check with nothing to check, and the floor in the gate is what caught it.
 *
 * Comment text is replaced by spaces and newlines rather than deleted, so every byte after it keeps its
 * offset and a finding can name the line a reader has to open.
 *
 * Strings are stepped over rather than read, so a `//` or `/*` inside one cannot open a comment. Escapes
 * are stepped over too. It does NOT try to tell a regex literal from a division, so a regex holding an
 * unbalanced quote could put the scanner off its place — which is why the gate asserts a FLOOR on how
 * many specifiers come back. A scanner that has lost its place stops finding imports, and a floor is
 * what turns that silence into a failure.
 */
export function scan(src) {
  const out = [];
  const spans = [];                     // [start, end) of every string literal, in src offsets
  let i = 0;
  const n = src.length;
  const blank = (from, to) => { for (let k = from; k < to; k++) out.push(src[k] === '\n' ? '\n' : ' '); };

  // Last significant character emitted, which is how a `/` is told apart from a regex literal.
  let prev = '';
  const remember = (ch) => { if (!/\s/.test(ch)) prev = ch; };
  const push = (ch) => { out.push(ch); remember(ch); };

  while (i < n) {
    const c = src[i], d = src[i + 1];

    if (c === '/' && d === '/') { const s = i; while (i < n && src[i] !== '\n') i++; blank(s, i); continue; }
    if (c === '/' && d === '*') {
      const s = i; i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i = Math.min(n, i + 2); blank(s, i); continue;
    }

    // A REGEX LITERAL, and skipping it is not fussiness. `const SPEC = /…(['"])…/g` two definitions
    // below holds one single quote and one double quote; without this branch the scanner opened a
    // string on them, ran past the end of the statement, and swallowed a comment 130 lines later —
    // which then reported `./src/engine/proof.js`, quoted inside that comment, as an import of this
    // file. The scanner turning its own regex into a false positive is the cleanest possible proof that
    // "it is only a comment" is not a safe assumption.
    //
    // The test is the standard one: a `/` after a value (identifier, number, `)`, `]`) is division;
    // anywhere else it opens a regex. `return /re/` reads as division under this rule and is therefore
    // scanned as code, which the newline reset below bounds to that one line.
    if (c === '/' && !/[A-Za-z0-9_$)\]]/.test(prev)) {
      const s = i; i++;
      let inClass = false;
      while (i < n && src[i] !== '\n') {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        else if (src[i] === '/' && !inClass) { i++; break; }
        i++;
      }
      blank(s, i); prev = '/'; continue;
    }

    if (c === "'" || c === '"' || c === '`') {
      const q = c, start = i;
      out.push(c); i++;
      while (i < n) {
        if (src[i] === '\\') { out.push(src[i], src[i + 1] ?? ''); i += 2; continue; }
        if (src[i] === q) break;
        // A NEWLINE ENDS A QUOTED STRING, because in JavaScript it does — an unterminated `'` is a
        // syntax error, not a multi-line string. Enforcing that here is what bounds the damage when the
        // regex rule above guesses wrong: the misparse cannot outlive the line it started on. Template
        // literals genuinely span lines and are the one exception.
        if (q !== '`' && src[i] === '\n') break;
        out.push(src[i]); i++;
      }
      if (i < n && src[i] === q) { out.push(q); i++; }
      spans.push([start, i]);
      prev = q; continue;
    }

    push(c); i++;
  }
  return { code: out.join(''), spans };
}

/** Comments blanked out, code and string bodies left in place. */
export const stripComments = (src) => scan(src).code;

// import x from './y.js' | export * from '../z.js' | import('./y.js') | require('./y.js')
// Only RELATIVE specifiers: a bare specifier is a package, which is `npm install`, and `node:` is the
// runtime. Both are somebody else's problem and neither can be missing from HEAD.
const SPEC = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*(['"])(\.\.?\/[^'"]*)\1/g;

/**
 * Relative specifiers this file actually imports.
 *
 * The keyword has to sit OUTSIDE every string literal, and that one condition is the difference between
 * a useful check and a nuisance. A first pass without it reported 35 findings of which 18 were real: nine
 * revert scripts run `spawnSync(process.execPath, ['-e', "import('./src/engine/proof.js')"])`, whose
 * specifier is resolved by a child process against the REPOSITORY ROOT, not against `gates/`; three more
 * are `find`/`replace` strings quoting the import line a revert is about to patch; and
 * `gate2-service.mjs` writes a probe file whose imports resolve where the probe is written. Every one of
 * those is a string whose contents are somebody else's cwd, and a scanner that over-reports gets ignored
 * as fast as one that cannot fail.
 *
 * Known limitation, stated rather than hidden: a template literal is treated as one string, so a real
 * `import()` written inside a `${…}` interpolation is not seen. There is none in this repository, and the
 * specifier floor in the gate is what would catch the scanner going quiet for any other reason.
 *
 * @returns {{ spec: string, line: number }[]}
 */
export function relativeSpecifiers(src) {
  const { code, spans } = scan(src);
  const inString = (k) => spans.some(([s, e]) => k > s && k < e);
  const found = [];
  for (const m of code.matchAll(SPEC)) {
    if (inString(m.index)) continue;
    found.push({ spec: m[2], line: code.slice(0, m.index).split('\n').length });
  }
  return found;
}

// What Node will accept for a specifier that has no extension. ESM demands the exact path, CJS will
// add an extension or an index file, and this list is the union: being LENIENT here is the safe
// direction, because the defect this catches is a module that is not in HEAD under any name at all.
const CANDIDATES = (t) => [t, `${t}.js`, `${t}.mjs`, `${t}.cjs`, `${t}.json`, `${t}.node`,
  `${t}/index.js`, `${t}/index.mjs`, `${t}/index.cjs`, `${t}/index.json`];

/**
 * One file's relative imports, resolved against a path set.
 *
 * Separated out and exported so the gate can run it over a FABRICATED file set as a positive control on
 * every run. A check whose own logic is only ever exercised on data that happens to be clean is a check
 * that reports PASS from an empty `readdir`, which is the disease this repository is organised against.
 *
 * `path.posix.join(dirname(importer), spec)` is the one line this has to get right: an earlier sweep of
 * committed imports produced eight false positives by resolving `../adapters/…` against the repository
 * root instead of against the importing file's own directory.
 *
 * @returns {{ specifiers: number, unresolved: {importer:string,spec:string,line:number,tried:string[]}[] }}
 */
export function unresolvedIn(importer, src, files) {
  const dir = path.posix.dirname(importer);
  const unresolved = [];
  let specifiers = 0;
  for (const { spec, line } of relativeSpecifiers(src)) {
    specifiers++;
    // Strip a query or fragment: `./worker.mjs?v=2` is a real thing and the file is `./worker.mjs`.
    const bare = spec.replace(/[?#].*$/, '');
    const target = path.posix.normalize(path.posix.join(dir, bare)).replace(/^\.\//, '');
    if (target.startsWith('../')) continue;     // outside the repository: not a claim about HEAD
    const tried = CANDIDATES(target);
    if (!tried.some((t) => files.has(t))) unresolved.push({ importer, spec, line, tried });
  }
  return { specifiers, unresolved };
}

/**
 * Every committed JS file whose relative import resolves to nothing in HEAD.
 *
 * The resolution is TEXTUAL and against HEAD's path set, not the filesystem — that is the whole point,
 * because the filesystem is what lied.
 *
 * @param {string} repo
 * @param {Set<string>} files  HEAD's path set
 * @returns {{ scanned: number, specifiers: number, unresolved: {importer:string,spec:string,line:number,tried:string[]}[] }}
 */
export function unresolvedImports(repo, files) {
  const js = [...files].filter((f) => /\.(js|mjs|cjs)$/.test(f) && !f.startsWith('node_modules/'));
  const blobs = headBlobs(repo, js);
  const unresolved = [];
  let specifiers = 0;
  for (const importer of js) {
    const src = blobs.get(importer);
    if (src === undefined) { unresolved.push({ importer, spec: '(the file itself)', line: 0, tried: ['git could not read this blob at HEAD'] }); continue; }
    const r = unresolvedIn(importer, src, files);
    specifiers += r.specifiers;
    unresolved.push(...r.unresolved);
  }
  return { scanned: js.length, specifiers, unresolved };
}

/** `npm run <name>` as published in committed .md/.html, and the scripts the manifests actually define. */
export function publishedScripts(repo, files) {
  const docs = [...files].filter((f) => /\.(md|html)$/.test(f));
  const blobs = headBlobs(repo, docs);
  const referenced = new Map();               // script name -> first "path:line" that publishes it
  for (const [doc, src] of blobs) {
    src.split(/\r?\n/).forEach((text, idx) => {
      for (const m of text.matchAll(/npm run ([a-z0-9:_-]+)/g)) {
        if (!referenced.has(m[1])) referenced.set(m[1], `${doc}:${idx + 1}`);
      }
    });
  }
  const defined = new Set();
  for (const manifest of ['package.json', 'zk/package.json']) {
    const src = headBlobs(repo, [manifest]).get(manifest);
    if (!src) continue;
    try { for (const k of Object.keys(JSON.parse(src).scripts || {})) defined.add(k); } catch { /* reported by the caller as an empty set */ }
  }
  return { referenced, defined };
}

export { posix, PROBE };
