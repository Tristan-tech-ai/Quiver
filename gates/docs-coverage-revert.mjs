// Proof that tools/docs-consistency.mjs can FAIL — on the defects it was measurably blind to.
//
// A checker that only ever passes is indistinguishable from no checker at all, and this one had
// already proved that: it reported CONSISTENT over a front page that told readers the paper had six
// parts when seven were served, over a README stale by 234 tests, and over a changelog entry with
// two empty table rows where the contract addresses belonged. All three were real, all three were
// published, and the tool was green on every one.
//
// So each defect is put BACK into the real file, and the tool is required to
//
//   1. be GREEN on it in DOCS_CONSISTENCY_PRE_WIDENING=1 — the pre-29-July walk. This is the blind
//      spot demonstrated rather than asserted: the old corpus really did pass over this text.
//   2. go RED on it by NAME in the default mode — the right file, and a message that identifies the
//      defect rather than merely counting to one.
//   3. be GREEN again once restored, because red-in-both-states is a checker broken a different way.
//
// The files are mutated through node:fs and restored from a string held in memory, with no shell
// anywhere in the path — which is not fastidiousness but the direct lesson of defect 3, whose entire
// cause was backticks inside a double-quoted `node -e` argument being command substitution.
//
// DO NOT RUN TWO COPIES OF THIS AT ONCE — not from two trees, not from two sessions.
// Measured on 30 July: this script mutates a real document and then asks the checker whether the tree is
// consistent, and the checker's corpus spans BOTH the service tree and the published mirror. So a run
// started from `Quiver` sees the file a run started from `hackathon/veritape` has mid-flight, one of them
// aborts on a baseline that is red through no fault of its own, and the aborting one exits through a path
// that has already written the defect and not yet restored it. That left `VERIFY_EXEC_VERIFY.md`
// published with a marginal of 3,318 — one of the exact wrong values this whole exercise is about,
// reintroduced by the tool built to catch it. Run them one after the other.
//
//   node gates/docs-coverage-revert.mjs        (npm run docs:revert)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVICE = join(HERE, '..');
const ROOT = join(SERVICE, '..', '..');
const TOOL = join(SERVICE, 'tools', 'docs-consistency.mjs');

const run = (pre, args = []) => {
  const env = { ...process.env };
  if (pre) env.DOCS_CONSISTENCY_PRE_WIDENING = '1';
  else delete env.DOCS_CONSISTENCY_PRE_WIDENING;
  const r = spawnSync(process.execPath, [TOOL, ...args], { cwd: SERVICE, encoding: 'utf8', env, timeout: 300_000 });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
};

// Which files did the OLD walk actually open? Asked of the tool itself rather than reconstructed
// here, because a reimplementation would only prove things about the reimplementation.
//
// This distinction is not cosmetic and it is not the same in both trees. Two of these defects were
// invisible POSITIONALLY — the file was never opened — and that is true of `README.md` in the
// service directory, which sat under `hackathon/veritape/` while `hackathon/` was walked one level
// deep. In the published mirror the very same defect sits in `Quiver/README.md`, which the old walk
// always read, so there it was never a blind spot at all and the old walk is expected to catch it.
// Asserting a remembered story about which is which would have made this script fail in the mirror
// for the wrong reason — it did, before this was measured instead.
const preCorpus = new Set(run(true, ['--list']).out.split('\n').map((l) => l.trim()).filter(Boolean));

// Each defect is the exact text that was published, restored verbatim. `from` is what the file says
// today; `to` is what it said when it was wrong. `names` are substrings every one of which must
// appear in the tool's output, and `file` must appear in it too.
const DEFECTS = [
  {
    id: 'SIX-PART-INDEX',
    what: "assets/landing.html — the service's own front page — indexed six parts while seven were served",
    file: join(SERVICE, 'assets', 'landing.html'),
    from: `  is served as plain markdown in seven parts, each small enough for a single fetch. Nothing is
  abridged — a test asserts the parts concatenate to the whole.</p>
  <ul class="facts" style="grid-template-columns:repeat(auto-fit,minmax(210px,1fr))">
    <li><span><a href="/paper/1">/paper/1</a></span>abstract · architecture · design principles</li>
    <li><span><a href="/paper/2">/paper/2</a></span>the twenty-two services</li>
    <li><span><a href="/paper/3">/paper/3</a></span>methodology</li>
    <li><span><a href="/paper/4">/paper/4</a></span>verification · walkthrough · <b>limitations</b></li>
    <li><span><a href="/paper/5">/paper/5</a></span>related work · the build</li>
    <li><span><a href="/paper/6">/paper/6</a></span>roadmap · conclusion</li>
    <li><span><a href="/paper/7">/paper/7</a></span>appendices · <b>checkable artifacts</b> · references</li>
  </ul>
  <p class="note">If you are assessing this and have two minutes, read
  <a href="/paper/4">part 4</a> — it is the limitations, including the ablation that undercuts our own
  headline result — and <a href="/paper/7">part 7</a>, which is every artifact you can check without`,
    to: `  is served as plain markdown in six parts, each small enough for a single fetch. Nothing is
  abridged — a test asserts the parts concatenate to the whole.</p>
  <ul class="facts" style="grid-template-columns:repeat(auto-fit,minmax(210px,1fr))">
    <li><span><a href="/paper/1">/paper/1</a></span>abstract · architecture · design principles</li>
    <li><span><a href="/paper/2">/paper/2</a></span>the twenty-two services</li>
    <li><span><a href="/paper/3">/paper/3</a></span>methodology</li>
    <li><span><a href="/paper/4">/paper/4</a></span>verification · <b>limitations</b> · related work</li>
    <li><span><a href="/paper/5">/paper/5</a></span>the build · roadmap · conclusion</li>
    <li><span><a href="/paper/6">/paper/6</a></span>appendices · <b>checkable artifacts</b> · references</li>
  </ul>
  <p class="note">If you are assessing this and have two minutes, read
  <a href="/paper/4">part 4</a> — it is the limitations, including the ablation that undercuts our own
  headline result — and <a href="/paper/6">part 6</a>, which is every artifact you can check without`,
    names: ['enumerates parts but omits /paper/7'],
  },
  {
    id: 'TEN-TABLES',
    what: 'assets/landing.html sold the paper as having ten tables from the day it grew an eleventh',
    file: join(SERVICE, 'assets', 'landing.html'),
    from: '  <p class="note">Full technical documentation with methods, eleven tables and 44 references, every one of them cited:',
    to: '  <p class="note">Full technical documentation with methods, ten tables and 44 references, every one of them cited:',
    names: ['says "ten tables" of the paper; it has 11'],
  },
  {
    id: 'README-152',
    what: 'README.md quoted 152 model-free tests — 234 stale — under hackathon/, which was walked top level only',
    file: join(SERVICE, 'README.md'),
    // The two trees do not share this file: the service directory carries a short operational
    // README and the published repository a long one, and the stale line reads differently in each.
    // The first candidate whose text is actually present is the one used, so the revert reverts what
    // is there rather than what it remembers being there.
    either: [
      {
        from: 'npm test                # 386 model-free tests (put-call parity, no-lookahead, martingale, greek finite-difference, liquidation invariant, …); 381 run here, 5 live-archive tests are skipped unless an archive RPC is configured',
        to: 'npm test                # 152 model-free tests (put-call parity, no-lookahead, martingale, greek finite-difference, liquidation invariant, …) + 5 live-archive tests behind an RPC flag',
      },
      {
        from: 'npm test      # 386 model-free tests — no network access required',
        to: 'npm test      # 152 model-free tests — no network access required',
      },
    ],
    names: ['quotes 152 model-free tests; the suite has 386'],
  },
  {
    id: 'EATEN-SPANS',
    what: 'assets/changelog.md shipped with two empty table rows and three inline code spans eaten by a shell',
    file: join(SERVICE, 'assets', 'changelog.md'),
    from: '| `QuiverPerpVerifier` | `0x139C116C3cDE9C750aA61fB75fa282C9e4a4E3a6` |\n| `PlonkVerifier` | `0xaFf7663e57BfF86605503E0aE0Bcde4B07524900` |',
    to: '|  |  |\n|  |  |',
    also: [
      {
        from: '`MarkMismatch`, a bent proof reverts `ProofRejected`. The refusal is provably about the INPUT and not\nthe arithmetic, because a proof held past the window is still accepted by `verifyProof` while the join',
        to: ', a bent proof reverts . The refusal is provably about the INPUT and not\nthe arithmetic, because a proof held past the window is still accepted by  while the join',
      },
      {
        from: 'build hash is unchanged at `q1-e1fa99d08887d6cc`. Full record in `docs/a0-hyperevm-verifier.md`.',
        to: 'build hash is unchanged at . Full record in .',
      },
    ],
    names: [
      'table row has no content in any of its 2 cells',
      'line begins with a comma',
      'sentence ends "at ."',
      'sentence ends "in ."',
    ],
  },
  // ── the gas figures ────────────────────────────────────────────────────────────────────────────
  // On 30 July every gas figure in the four `VERIFY_*.md` gate reports disagreed with the JSON that
  // produced it, and this tool reported CONSISTENT over all of them across 225 documents. Rule 9 was
  // written for that, and these four scenarios put the published text back.
  //
  // They are deliberately four rather than one, because rule 9 has four independent ways to be right
  // and a revert that exercises one of them proves nothing about the other three.
  {
    id: 'GAS-UNCITED-PROSE',
    what: 'VERIFY_EXEC_VERIFY.md published three gas figures in one table with no artifact behind any of them',
    files: [join(ROOT, 'hackathon', 'VERIFY_EXEC_VERIFY.md'), join(SERVICE, 'docs', 'verify-exec-verify.md')],
    from: '| `constantproduct` (benchmark only) | 671 | 1,293 | 10 | 2048 | 273,564 <!--gas:gateB5-2-constantproduct-evm#acceptGas~2%--> | 7,694 |\n'
      + '| `execadverse` (benchmark + headline) | 932 | 1,797 | 15 | 2048 | 281,984 <!--gas:gateB5-5-execadverse-evm#acceptGas~2%--> | 8,754 |\n'
      + '| delta | +261 | +504 | +5 | **unchanged** | *see below — a subtraction of two samples measures nothing* | +1,060 |',
    to: '| `constantproduct` (benchmark only) | 671 | 1,293 | 10 | 2048 | 276,892 gas | 7,694 |\n'
      + '| `execadverse` (benchmark + headline) | 932 | 1,797 | 15 | 2048 | 279,280 gas | 8,754 |\n'
      + '| delta | +261 | +504 | +5 | **unchanged** | **+2,388 gas (+0.9%)** | +1,060 |',
    names: [
      'publishes 276,892 gas without citing the artifact that measured it',
      'publishes 279,280 gas without citing the artifact that measured it',
      'publishes 2,388 gas without citing the artifact that measured it',
    ],
  },
  {
    id: 'GAS-UNCITED-TABLE',
    what: 'VERIFY_PORTFOLIO_GATE.md published six per-leg gas figures in a table column where the word "gas" appears only in the header',
    files: [join(ROOT, 'hackathon', 'VERIFY_PORTFOLIO_GATE.md'), join(SERVICE, 'docs', 'verify-portfolio-gate.md')],
    // This is a SEPARATE scenario from the one above and not a duplicate of it: the prose half of rule
    // 9 keys on the word "gas" next to the number, and in this table that word is in the header and on
    // none of the rows. A rule with only the prose half was measured green over all six of these.
    from: '| 1 | 279,678 <!--gas:gateB10-portfolio-perleg#gasByLegCount.0.gas~2%--> | 279,678 |',
    to: '| 1 | 276,448 | 276,448 |',
    names: ['table column "gas" publishes 276,448 without citing the artifact that measured it'],
  },
  {
    id: 'GAS-WRONG-ARTIFACT',
    what: 'the benchmark verifier\'s gas figure attributed to the headline verifier — a real 3% misattribution, not a re-sample',
    files: [join(ROOT, 'hackathon', 'VERIFY_EXEC_VERIFY.md'), join(SERVICE, 'docs', 'verify-exec-verify.md')],
    // Presence is not enough. This scenario leaves the citation in place and points it at the WRONG
    // artifact, which is what "a published marginal took its two terms from different runs" is made
    // of. It proves the VALUE comparison can fail, where GAS-UNCITED-* only prove the presence check
    // can.
    // The wrong artifact is the 3-leg PORTFOLIO verifier, not the sibling `execadverse` one. Pointing
    // it at `execadverse` first put the scenario 2.99% out in this tree and 2.05% out in the mirror —
    // red in both, but by 0.05 percentage points in one of them, which is a scenario that would flip to
    // MISS on the next re-run of a gate and teach the reader that the revert is flaky rather than that
    // the rule works. A misattribution the rule should catch has to be unambiguously outside the band.
    from: '**B5-2** `constantproduct` in an EVM — PASSED. Accept 273,564 gas <!--gas:gateB5-2-constantproduct-evm#acceptGas~2%-->',
    to: '**B5-2** `constantproduct` in an EVM — PASSED. Accept 273,564 gas <!--gas:gateB8-2-portfolio-evm#acceptGas~2%-->',
    names: ['citing gateB8-2-portfolio-evm#acceptGas within ~2%'],
  },
  {
    id: 'GAS-MARGINAL-3318',
    what: 'the marginal restored to 3,318 — one of the four values that one quantity has been published as',
    files: [join(ROOT, 'hackathon', 'VERIFY_EXEC_VERIFY.md'), join(SERVICE, 'docs', 'verify-exec-verify.md')],
    // A DERIVED statistic is held EXACTLY, with no tolerance, because the whole defect was that its two
    // terms came from different runs. 2,388 / 3,318 / 6,340 / 8,420 are the four values this one
    // quantity has taken; every one of them is now a red.
    from: '  **+3,815 gas** <!--gas:probe-execadverse-marginal#marginal.meanMinusMean-->, standard error 288, 95%',
    to: '  **+3,318 gas** <!--gas:probe-execadverse-marginal#marginal.meanMinusMean-->, standard error 288, 95%',
    names: ['publishes 3,318 citing probe-execadverse-marginal#marginal.meanMinusMean'],
  },
];

const results = [];
const say = (s = '') => console.log(s);

say(`Proving tools/docs-consistency.mjs can fail — ${DEFECTS.length} defects it was measurably blind to.\n`);

const base = run(false);
if (base.code !== 0) {
  console.error('ABORTED: the tool is already red on the untouched tree, so nothing below would mean anything.\n');
  console.error(base.out);
  process.exit(1);
}
say(`  BASELINE  ${base.out.trim().split('\n').pop()}\n`);

for (const d of DEFECTS) {
  // A defect may live at a DIFFERENT PATH in each tree. The four gate reports sit at
  // `hackathon/VERIFY_*.md` beside the service and at `Quiver/docs/verify-*.md` in the published
  // mirror, so `files` lists the candidates and the first one present is the one reverted. Naming a
  // single path made every gas defect ERROR OUT in the mirror, which reports a broken revert rather
  // than a broken checker — the same trap the `preCorpus` comment above records.
  if (d.files) {
    const found = d.files.find((p) => existsSync(p));
    if (!found) {
      results.push({ id: d.id, ok: false });
      say(`  *MISS*  ${d.id.padEnd(16)} ${d.what}`);
      say(`     ERROR none of these paths exist in this tree: ${d.files.map((p) => relative(ROOT, p)).join(', ')}`);
      say();
      continue;
    }
    d.file = found;
  }
  const original = readFileSync(d.file, 'utf8');
  const chosen = d.either
    ? d.either.find((e) => original.includes(e.from)) || d.either[0]
    : { from: d.from, to: d.to };
  const edits = [chosen, ...(d.also || [])];
  let ok = true;
  const detail = [];
  try {
    let text = original;
    for (const e of edits) {
      if (!text.includes(e.from)) {
        throw new Error(`the text this defect reverts is not in ${relative(ROOT, d.file)} any more — the revert is stale, which is itself a finding`);
      }
      text = text.replace(e.from, e.to);
    }
    writeFileSync(d.file, text);

    // 1. the OLD walk, and what it was entitled to see
    // WHY THIS IS NOT `preCorpus.has(d.file)`, which is what it said and which never once matched.
    // `--list` emits paths resolved against the checker's own ROOT, which lands in the MIRROR tree,
    // while `d.file` is the working-tree copy being edited. Two absolute paths for the same document,
    // never equal, so `wasRead` was always false and every case printed "it never opened this file" —
    // including the changelog, which it read all along. The branch below was correct and unreachable,
    // which is this project's own favourite defect wearing a different hat.
    //
    // Matched on the last two segments instead, and DELIBERATELY reporting `null` rather than guessing
    // when that is ambiguous: a wrong explanation of why a check was blind is worse than no explanation.
    const tail = (p) => p.replace(/\\/g, '/').split('/').slice(-2).join('/').toLowerCase();
    const want = tail(d.file);
    const matches = [...preCorpus].filter((p) => tail(p) === want);
    const wasRead = matches.length === 1 ? true : matches.length > 1 ? null : false;
    const pre = run(true);
    const blind = pre.code === 0;
    if (wasRead === null) {
      detail.push(blind
        ? '     pre-widening walk: GREEN — but whether it read this file is AMBIGUOUS from --list, so the kind of blindness is not claimed'
        : `     pre-widening walk: RED\n${pre.out}`);
      ok &&= blind;
    } else if (!wasRead) {
      detail.push(blind
        ? '     pre-widening walk: GREEN — it never opened this file, which is the blind spot itself'
        : `     pre-widening walk: RED — it does not read this file, so it cannot have found this\n${pre.out}`);
      ok &&= blind;
    } else {
      detail.push(blind
        ? '     pre-widening walk: GREEN over a file it DID read — the miss was in the rules, not the corpus'
        : '     pre-widening walk: RED — this tree already read this file, so here it was never a blind spot');
    }

    // 2. the current walk must go red BY NAME
    const now = run(false);
    const red = now.code !== 0;
    const namedFile = now.out.includes(relative(ROOT, d.file));
    const missing = d.names.filter((n) => !now.out.includes(n));
    ok &&= red && namedFile && !missing.length;
    if (red && namedFile && !missing.length) {
      detail.push(`     named the file: ${relative(ROOT, d.file)}`);
      for (const line of now.out.split('\n')) {
        if (d.names.some((n) => line.includes(n))) detail.push(`     caught: ${line.trim()}`);
      }
    } else {
      detail.push(`     current walk: red=${red} named-the-file=${namedFile} missing=${JSON.stringify(missing)}`);
      detail.push(now.out.split('\n').slice(0, 20).map((l) => `       ${l}`).join('\n'));
    }
  } catch (err) {
    ok = false;
    detail.push(`     ERROR ${err.message}`);
  } finally {
    writeFileSync(d.file, original);
  }

  // 3. green again once restored
  const after = run(false);
  const restored = after.code === 0 && readFileSync(d.file, 'utf8') === original;
  ok &&= restored;
  detail.push(restored
    ? '     restored: GREEN again on the untouched file'
    : `     restored: NOT green again — ${after.out.trim()}`);

  results.push({ id: d.id, ok });
  say(`  ${ok ? 'CAUGHT ' : '*MISS* '} ${d.id.padEnd(16)} ${d.what}`);
  for (const line of detail) say(line);
  say();
}

const caught = results.filter((r) => r.ok).length;
say('='.repeat(100));
say(`  ${caught}/${results.length} defects were caught BY NAME by the widened walk, and missed by the walk that shipped them.`);
say();
if (caught !== results.length) {
  say(`FAILED — ${results.length - caught} defect(s) the widened walk was supposed to catch: ${results.filter((r) => !r.ok).map((r) => r.id).join(', ')}`);
  process.exit(1);
}
say('PASSED — every defect was caught by name, every file was restored byte-for-byte, and the');
say('         checker is green again on the untouched tree.');
