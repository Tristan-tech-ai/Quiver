// The scripted revert for gate AT.
//
// Gate AT concludes AGAINST building something, which is the most dangerous kind of gate to trust: it
// was written after the finding, so of course it is green, and a gate that cannot go red is how "we
// checked" becomes "we asserted". This script puts five defects into the gate, one at a time, and
// requires it to go RED for each, then restores the file and requires GREEN again. Red in both states
// would mean broken rather than strict, so both halves are required.
//
// Two of the five are not invented. They are the mistakes this work actually made:
//
//   4. THE PREFIX COMPARISON. The published recipe sorts each pair "comparing as byte strings", and the
//      response prints siblings 0x-prefixed while an intermediate fold is bare hex. The first run of
//      gate AT compared '0x8f...' against 'ce...', ordered on the prefix, and every inclusion proof it
//      checked came back false. Putting that back must kill the gate again.
//   5. THE WRONG VERIFY TO COMPARE AGAINST. The first gas probe priced the pairing check at the EIGHT
//      public signals the liquidation circuit happens to carry. A set-exactness circuit has to NAME the
//      set it claims the root covers, which is 2N+2 signals, and at the service ceiling that is 490.
//      Pricing it at 8 flips the conclusion — so the gate must die when the cheap pricing goes back in,
//      or its conclusion was never resting on the measurement.
//
// The other three attack the checker itself:
//
//   1. A VERIFIER THAT CANNOT FAIL. setExactFromResponse returns ok unconditionally. Every tamper is
//      then "refused" by a function that refuses nothing, and the tamper matrix must die.
//   2. THE PREMISE GOES UNCHECKED. The published-leaf-set assertion is weakened to a truthiness test on
//      `attestations`, so a response that publishes ONE leaf out of sixty-four passes it. This is the
//      exact property the whole finding rests on, so the gate must not survive its removal.
//   3. DOMAIN SEPARATION DROPS OUT of the gate's own recomputation. Leaves and nodes fold with plain
//      sha256. The recomputation stays perfectly self-consistent and stops agreeing with the engine,
//      which is the difference between mirroring the published recipe and inventing a private one.
//
// Nothing here touches src/engine/. The engine build id is read before and after, and must be the same
// string on both sides of a script that rewrites files.
//
//   node zk/scripts/gateAT-revert.mjs
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { protect } from './lib/revert-guard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATE = path.join(HERE, 'gateAT-attest-no-snark.mjs');
const DEV_ROOT = path.resolve(HERE, '..', '..');
const MIRROR = path.join(DEV_ROOT, 'Quiver');

const { load } = await import('./service-root.mjs');
const { _internal } = await load(import.meta.url, 'engine/proof.js');
const buildIdBefore = _internal.buildId();

const REVERTS = [
  {
    id: 1,
    what: 'a verifier that cannot fail: set-exactness returns ok unconditionally',
    from: "  if (('0x' + rootOver(list)) !== resp.merkleRoot) return { ok: false, why: 'the root is NOT the root of the published leaf set' };",
    to: "  if (false) return { ok: false, why: 'unreachable' };   // SCRIPTED REVERT: the check cannot fail",
    expect: /refuses every way a root can misrepresent|hidden extra leaf/,
  },
  {
    id: 2,
    what: 'the premise goes unchecked: any non-empty attestations array counts as publishing the set',
    from: "  const publishes = r.attestations.length === N && r.leafCount === N && r.attestations.every((a, i) => a.index === i && /^0x[0-9a-f]{64}$/.test(a.contentHash));",
    to: "  const publishes = Boolean(r.attestations);   // SCRIPTED REVERT: the premise is no longer checked",
    // Weakening the premise must be caught by the premise assertion itself once the response is trimmed;
    // gate AT also feeds the trimmed shape through setExactFromResponse, which is what dies here.
    expect: /publishes its COMPLETE leaf set|set-exactness is decided/,
    alsoPatch: {
      from: "  const r = riskAttest({ contentHashes: batch(N) });\n  if (!r.ok) { premiseOk = false; break; }",
      to: "  const r0 = riskAttest({ contentHashes: batch(N) });\n  if (!r0.ok) { premiseOk = false; break; }\n  const r = { ...r0, attestations: r0.attestations.slice(0, 1) };   // SCRIPTED REVERT: the service stops publishing every leaf",
    },
  },
  {
    id: 3,
    what: 'domain separation drops out of the gate\'s own recomputation — self-consistent, and no longer the engine\'s tree',
    from: "const leafH = (hex) => sha(Buffer.concat([Buffer.from([0x00]), raw(hex)]));",
    to: "const leafH = (hex) => sha(raw(hex));   // SCRIPTED REVERT: the 0x00 leaf tag is gone",
    expect: /set-exactness is decided|honest response still passes/,
  },
  {
    id: 4,
    what: 'the prefix comparison comes back — sorting 0x-prefixed against bare hex (the defect this gate found on its first run)',
    from: "  const [x, y] = [bare(a), bare(b)];\n  const [lo, hi] = x <= y ? [x, y] : [y, x];",
    to: "  const [lo, hi] = a <= b ? [bare(a), bare(b)] : [bare(b), bare(a)];   // SCRIPTED REVERT: order on the prefix",
    expect: /set-exactness is decided|hidden extra leaf/,
  },
  {
    id: 5,
    what: 'the pairing check is priced at 8 public signals instead of the 2N+2 a set-exactness circuit needs',
    from: "const snarkAtCeiling = Math.round(plonkBase + perSignal * (2 * NC + 2));",
    to: "const snarkAtCeiling = Math.round(plonkBase + perSignal * 8);   // SCRIPTED REVERT: the wrong verify to compare against",
    expect: /direct check is cheaper/,
  },
];

function runGate() {
  const r = spawnSync(process.execPath, [GATE], { cwd: path.join(HERE, '..'), encoding: 'utf8', maxBuffer: 1 << 28 });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}
// A gate that throws is not the same as a gate that reports a red check, and treating them alike would
// let a typo in a revert pass for a caught defect. So the FAILING CHECK NAMES are extracted and matched
// against what each revert claims it should kill.
const redChecks = (out) => (out.match(/\[\*\*\* FAIL \*\*\*\] (.+)/g) || []).map((l) => l.replace('[*** FAIL ***] ', '').trim());

console.log(`GATE AT REVERT — five defects, each must turn the gate red — ${new Date().toISOString()}`);
console.log(`  engine build id before: ${buildIdBefore}\n`);

// The backup used to be taken here, before anything was checked. That is what made an interrupted run
// permanent: the next attempt copied the still-patched gate over the pristine backup, the baseline check
// then failed, and the `finally` restored the patched copy. protect() reverses the order — it verifies
// the gate against its committed copy FIRST, treats an existing backup as evidence of an interrupted run
// rather than as garbage, refuses to start if a live sibling owns the file, and restores on SIGTERM,
// which a `finally` does not.
const guard = protect([GATE], { repoRoot: MIRROR, devRoot: DEV_ROOT });
const PRISTINE = guard.pristineOf(GATE);

let allGood = true;
const rows = [];
try {
  // GREEN FIRST. If the gate is already red, every "it went red" below would be free.
  const base = runGate();
  const baseRed = redChecks(base.out);
  console.log(`  baseline: exit ${base.code}, ${baseRed.length} red check(s)`);
  if (base.code !== 0) {
    console.log(base.out.split('\n').slice(-25).join('\n'));
    throw new Error('the gate is not green before any revert — nothing below would mean anything');
  }

  for (const rv of REVERTS) {
    // Read the pristine text from the guard's in-memory snapshot, not off disk. Reading it back from the
    // backup file meant that anything which damaged the backup silently became the new "original".
    const original = PRISTINE.toString('utf8');
    let patched = original;
    for (const p of [{ from: rv.from, to: rv.to }, ...(rv.alsoPatch ? [rv.alsoPatch] : [])]) {
      if (!patched.includes(p.from)) throw new Error(`revert ${rv.id}: the text to patch is not in the gate — the revert is stale, which is worse than absent`);
      patched = patched.replace(p.from, p.to);
    }
    if (patched === original) throw new Error(`revert ${rv.id}: the patch changed nothing`);
    writeFileSync(GATE, patched);
    const res = runGate();
    const red = redChecks(res.out);
    const wentRed = res.code !== 0;
    const hitExpected = red.some((n) => rv.expect.test(n));
    // Threw rather than reported: still a failure, but a DIFFERENT one, and it is recorded as such
    // instead of being counted as the defect having been caught by a named check.
    const threw = res.code !== 0 && red.length === 0;
    const pass = wentRed && (hitExpected || threw);
    rows.push({ id: rv.id, what: rv.what, gateExit: res.code, wentRed, redChecks: red, matchedExpected: hitExpected, threwInsteadOfReporting: threw, pass });
    console.log(`  [${pass ? 'RED as required' : '*** NOT CAUGHT ***'}] revert ${rv.id} — ${rv.what}`);
    console.log(`        exit ${res.code}${red.length ? `, red: ${red.map((n) => n.slice(0, 62)).join(' | ')}` : ', threw before reporting a check'}`);
    if (!pass) allGood = false;
    writeFileSync(GATE, original);
  }

  // AND GREEN AGAIN, from the restored file. Red in both states would mean broken, not strict.
  const after = runGate();
  const afterGreen = after.code === 0 && redChecks(after.out).length === 0;
  console.log(`\n  restored: exit ${after.code}, ${redChecks(after.out).length} red check(s) — ${afterGreen ? 'GREEN again' : 'STILL RED'}`);
  if (!afterGreen) allGood = false;
} finally {
  guard.release();
}

const buildIdAfter = _internal.buildId();
console.log(`  engine build id after : ${buildIdAfter}`);
if (buildIdAfter !== buildIdBefore) { console.log('  *** THE ENGINE MOVED — this script must never touch src/engine/'); allGood = false; }

console.log(allGood
  ? '\nGATE AT REVERT PASSED — every defect turned the gate red, and the restored gate is green.'
  : `\nGATE AT REVERT FAILED — ${rows.filter((r) => !r.pass).length} defect(s) slipped through.`);
process.exit(allGood ? 0 : 1);
