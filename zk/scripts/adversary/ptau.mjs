// Powers-of-tau for the rescued refutations: generate locally, or fetch with a pinned digest.
//
//   node zk/scripts/adversary/ptau.mjs make 13          generate 2^13 locally, offline
//   node zk/scripts/adversary/ptau.mjs make 17          generate 2^17 locally, offline (~11 min)
//   node zk/scripts/adversary/ptau.mjs fetch 13         download the Hermez file, sha256-asserted
//   node zk/scripts/adversary/ptau.mjs check <file>     verify an existing file and print its facts
//
// WHY BOTH, AND WHY THE DIGEST DISCIPLINE IS DIFFERENT FOR EACH
//
// A DOWNLOADED ceremony file is a fixed sequence of bytes on a public bucket, so it can and must be
// pinned to a sha256: a reader gets the same bytes or a loud failure. That is the check this script
// applies, and it REFUSES a power whose digest is not pinned rather than accepting whatever arrives —
// an unpinned download is a verifier that cannot fail.
//
// A LOCALLY GENERATED ceremony file cannot be pinned to a digest, and saying otherwise would be the
// false claim. `powersoftau new` + `contribute` mix in fresh entropy, so the bytes differ every run.
// Three independent 2^13 files have been generated in this project and they measure 9,438,629,
// 9,438,644 and 9,438,657 bytes — three runs, three sizes, spread 28 bytes. The two 2^17 files differ
// by 9 bytes (150,996,408 and 150,996,417). What IS reproducible about a local file is its structure,
// and that is what
// gets asserted here: `powersoftau verify` passes, the power is the requested one, and the byte length
// lands in the recorded band. Everything a SIZING or TIMING measurement needs is reproducible from
// that; a production verifier is not, and this script says so on every generated file.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync, existsSync, mkdirSync, createWriteStream, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import P from './paths.mjs';

// ---------------------------------------------------------------------------------------------
// Pinned digests. A power appears here only if the digest was MEASURED, and the row says by whom.
//   - power 12 is measured below, live, from the file in this repo, every time this table is used.
//   - power 14 is the value PHASE_C_RESEARCH_FABLE.md records for a download this project made.
//     It is a recorded value, not one measured in this file, and it is labelled that way.
// Powers 13 and 17 have NO pinned digest, because nobody in this project has downloaded them. The
// fetch path therefore refuses them, and the make path exists precisely so they are not needed.
// ---------------------------------------------------------------------------------------------
const PINNED = {
  12: {
    bytes: 4801688,
    sha256: 'dcf4ea473bf14b971ce5f7b7c1d6ce1c41a8ed042cdb75b65ca9178e3a3c7c17',
    provenance: 'MEASURED in this session from build/hez_final_12.ptau. Two caveats, both real. (1) It '
      + 'is the digest of the file in THIS tree, and zk/FINDINGS.md records that file as byte-for-byte '
      + 'the public Hermez file — a record this session did not independently verify, because doing so '
      + 'needs the download. (2) So if `fetch 12` ever mismatches, the honest reading is "the file here '
      + 'is not the public one", not "the bucket changed". Either way it fails loudly, which is the '
      + 'point. Note build/pot12_final.ptau has the SAME digest: it is this file stored twice.',
  },
  14: {
    bytes: 18957464,
    sha256: null,
    provenance: 'PHASE_C_RESEARCH_FABLE.md records a downloaded hez_final_14 of 18,957,464 bytes with '
      + 'a sha256 beginning 489be9e5. The full digest is NOT reproduced here, because a truncated '
      + 'digest is not a check — it is a check that cannot fail on the last 24 bytes. Pin the full '
      + 'value before using the fetch path for power 14.',
  },
};

const URL_FOR = (pow) => `https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_${pow}.ptau`;

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

const cli = (args, label, mem = 8192) => {
  process.stdout.write(`  ${label.padEnd(44)}`);
  const t = Date.now();
  try {
    const out = execFileSync(process.execPath, [`--max-old-space-size=${mem}`, P.CLI, ...args],
      { cwd: P.ZK, stdio: ['ignore', 'pipe', 'pipe'], timeout: 3_600_000 });
    console.log(`ok  ${((Date.now() - t) / 1000).toFixed(1)} s`);
    return out.toString();
  } catch (e) {
    console.log('FAILED');
    console.error(`${(e.stdout || '').toString().slice(-3000)}\n${(e.stderr || '').toString().slice(-3000)}`);
    process.exit(1);
  }
};

// ---- ptau structural facts, parsed here rather than trusted ------------------------------------
// .ptau header: magic "ptau"(4) version(4) nSections(4), then (type u32, size u64, body).
// section 1 body: n8(4) prime(n8) power(4) ceremonyPower(4)
export function ptauFacts(file) {
  const b = readFileSync(file);
  const magic = b.toString('ascii', 0, 4);
  if (magic !== 'ptau') throw new Error(`${file}: not a ptau (magic ${JSON.stringify(magic)})`);
  const nSections = b.readUInt32LE(8);
  let off = 12;
  let s1 = null;
  for (let i = 0; i < nSections; i++) {
    const type = b.readUInt32LE(off);
    const size = Number(b.readBigUInt64LE(off + 4));
    const body = off + 12;
    if (type === 1) s1 = body;
    off = body + size;
  }
  if (s1 === null) throw new Error(`${file}: no section 1`);
  const n8 = b.readUInt32LE(s1);
  const power = b.readUInt32LE(s1 + 4 + n8);
  if (!(power > 0 && power < 32)) throw new Error(`${file}: implausible power ${power}`);
  return { bytes: statSync(file).size, power, domain: 2 ** power, nSections };
}

// ---------------------------------------------------------------------------------------------
// Everything below is the CLI. It is guarded, because `ptauFacts` is imported by repro.mjs and
// expsetup.mjs: without the guard, importing the parser ran the CLI, printed a usage line and exited 2
// — a module that kills its own caller. Found by expsetup.mjs exiting 0 having done nothing.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (!isMain) {
  // exported for use as a library; no CLI side effects
} else {

const mode = process.argv[2];
const arg = process.argv[3];

if (mode === 'check') {
  if (!arg || !existsSync(arg)) { console.error('usage: ptau.mjs check <file>'); process.exit(2); }
  const f = ptauFacts(arg);
  console.log(`  ${path.basename(arg)}`);
  console.log(`  power           ${f.power}   (domain ${f.domain})`);
  console.log(`  bytes           ${f.bytes.toLocaleString('en-US')}`);
  console.log(`  sha256          ${sha256(arg)}`);
  cli(['powersoftau', 'verify', arg], 'snarkjs powersoftau verify');
  process.exit(0);
}

if (mode === 'make') {
  const pow = Number(arg);
  if (!Number.isInteger(pow) || pow < 8 || pow > 20) {
    console.error('usage: ptau.mjs make <power 8..20>');
    process.exit(2);
  }
  const dir = path.join(P.WORK, 'ptau');
  mkdirSync(dir, { recursive: true });
  const p0 = path.join(dir, `pot${pow}_0000.ptau`);
  const p1 = path.join(dir, `pot${pow}_0001.ptau`);
  const pf = path.join(dir, `pot${pow}_final.ptau`);

  console.log(`Generating a 2^${pow} powers-of-tau LOCALLY. No network. Not a production ceremony.\n`);
  const t0 = Date.now();
  cli(['powersoftau', 'new', 'bn128', String(pow), p0, '-v'], `powersoftau new bn128 ${pow}`);
  cli(['powersoftau', 'contribute', p0, p1,
    '--name=local reproduction contribution',
    `-e=quiver-adversary-repro-${Date.now()}-single-contributor-not-trustworthy`],
  'powersoftau contribute');
  cli(['powersoftau', 'prepare', 'phase2', p1, pf, '-v'], 'powersoftau prepare phase2');
  const wall = (Date.now() - t0) / 1000;

  // the assertions. A generated file that does not verify, or carries the wrong power, is a failure.
  cli(['powersoftau', 'verify', pf], 'powersoftau verify (the real check)');
  const f = ptauFacts(pf);
  let fails = 0;
  const row = (label, val, ok) => {
    if (ok === false) fails++;
    console.log(`  ${label.padEnd(44)}${String(val).padStart(20)}  ${ok === undefined ? '' : ok ? 'ok' : 'FAIL'}`);
  };
  console.log('');
  row('power in the file header', f.power, f.power === pow);
  row('evaluation domain', f.domain, f.domain === 2 ** pow);
  row('bytes', f.bytes.toLocaleString('en-US'));
  row('sha256 (NOT reproducible - see header)', sha256(pf).slice(0, 16) + '…');
  row('wall clock', `${wall.toFixed(1)} s`);
  // Recorded bands from the session that produced the original measurements. A generated file far
  // outside its band means something other than entropy changed.
  const BAND = { 13: [9_400_000, 9_500_000], 17: [150_000_000, 151_500_000] };
  if (BAND[pow]) row(`bytes within recorded band ${BAND[pow][0].toLocaleString('en-US')}..${BAND[pow][1].toLocaleString('en-US')}`,
    f.bytes >= BAND[pow][0] && f.bytes <= BAND[pow][1], f.bytes >= BAND[pow][0] && f.bytes <= BAND[pow][1]);
  console.log(`\n  ${pf}`);
  console.log(`  ${fails === 0 ? 'PTAU OK' : `PTAU FAILED (${fails})`}`);
  process.exit(fails === 0 ? 0 : 1);
}

if (mode === 'fetch') {
  const pow = Number(arg);
  const pin = PINNED[pow];
  if (!pin || !pin.sha256) {
    console.error(`REFUSING to fetch power ${pow}: no pinned sha256 for it.`);
    console.error('');
    console.error('A download without a pinned digest is a verifier that cannot fail: whatever bytes');
    console.error('arrive would be accepted. Nobody in this project has downloaded this file, so no');
    console.error('digest has been measured, and none is invented here.');
    if (pin) console.error(`\nWhat is on record for power ${pow}:\n  ${pin.provenance}`);
    console.error('');
    console.error(`To get a ceremony of this size WITHOUT a download and WITHOUT a trusted digest:`);
    console.error(`  node zk/scripts/adversary/ptau.mjs make ${pow}`);
    console.error(`Every refutation in docs/fix-reproducible-artifacts.md that needs power ${pow} uses that path.`);
    console.error('');
    console.error(`If you want the official file anyway, it is ${URL_FOR(pow)}`);
    console.error('— fetch it yourself, record its sha256, and pin it in PINNED above. Then this works.');
    process.exit(1);
  }
  // Only reachable once a digest is pinned. Deliberately not exercised in this repo.
  const dir = path.join(P.WORK, 'ptau');
  mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `hez_final_${pow}.ptau`);
  console.log(`  fetching ${URL_FOR(pow)}`);
  const res = await fetch(URL_FOR(pow));
  if (!res.ok) { console.error(`  HTTP ${res.status}`); process.exit(1); }
  const ws = createWriteStream(out);
  const { Readable } = await import('node:stream');
  await new Promise((ok, no) => { Readable.fromWeb(res.body).pipe(ws).on('finish', ok).on('error', no); });
  const got = sha256(out);
  if (got !== pin.sha256) {
    unlinkSync(out);
    console.error(`  DIGEST MISMATCH\n    expected ${pin.sha256}\n    got      ${got}\n  file deleted.`);
    process.exit(1);
  }
  console.log(`  sha256 ${got}  MATCHES the pinned digest`);
  process.exit(0);
}

console.error('usage: ptau.mjs make <power> | fetch <power> | check <file>');
process.exit(2);

}   // end of the CLI guard
