// GATE D4, the negative gate. It does not check that attestation works. It checks that the
// services which CANNOT attest their inputs do not say they can.
//
// PHASE_D_RESEARCH.md §6 specifies it in one paragraph and §7 calls it "the highest ratio of
// protection to effort in this document":
//
//     D4, the one that matters most. A negative gate: assert that services with no attestation path
//     (options-desk, protocol-pulse, poly-*, the keyed OKX five) do not claim one. If a future edit
//     attaches an attestation field to a Deribit answer, this goes red. The failure mode this project
//     keeps catching is a claim outrunning what was built, and this is the gate that catches it in
//     the input layer.
//
// Built as specified, plus the one thing the brief adds: that a fabricated or tampered input does not
// silently produce a confident answer. Five parts, and every one of them can fail:
//
//   D4.1  the register is complete and is not a story. Its host list and its categories are checked
//         against a census PARSED OUT OF src/services.js and the import closure of every engine, so a
//         new service, a newly added fetch, or a quietly reclassified one turns the gate red.
//   D4.2  the ten no-mechanism services produce envelopes with no input-attestation claim in them,
//         through the real proof.js envelope builders.
//   D4.3  the scanner can actually catch things. Twelve injection shapes, at depth, in arrays, in key
//         names and in prose. A detector nobody has tried to defeat is not a detector.
//   D4.4  attachSibling refuses the exact edit the research names: an attestation field on a Deribit
//         answer. And it refuses it for all ten, and permits it only where a mechanism was measured
//         AND the sibling names its own gaps.
//   D4.5  fabricated and tampered inputs do not produce a confident answer: a tampered result breaks
//         its content hash; a fabrication below the divergence floor is reported as UNDETECTABLE
//         rather than as agreement; a single source is refused outright.
//
//   node --test gates/gateD4-no-false-attestation.mjs        (npm run gate:d4)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SERVICES } from '../src/services.js';
import { proofEnvelope, observationEnvelope, _internal } from '../src/engine/proof.js';
import {
  INPUT_ATTESTATION, CATEGORY, EXPECTED_CENSUS, census, servicesIn,
  scanClaims, scanEnvelope, scanCorrectnessClaims, attachSibling, withDivergenceDisclosure,
  mayCarryInputAttestation, InputClaimError, ENVELOPE_CLAIM_ALLOWLIST,
} from '../src/util/inputClaims.js';
import { buildDisclosure, FLOOR, measure, SOURCES } from '../src/util/divergence.js';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SRC = join(ROOT, 'src');

/* ─────────────────────── the census, parsed from source ───────────────────────
 *
 * Written as a parser rather than as a table because a table is a claim about the code and a parser
 * is a reading of it. This reproduces PHASE_D_RESEARCH.md §1 independently: 22 services, 15 that can
 * ship an observation envelope, 14 that can contact an external host, and macro-sentry contacting
 * nothing. If any of those move, the gate says so instead of the register quietly being wrong.
 */
function importsOf(file) {
  const txt = readFileSync(file, 'utf8');
  return [...txt.matchAll(/import\s+(?:([\w*\s{},]+?)\s+from\s+)?['"](\.[^'"]+)['"]/g)]
    .map((m) => ({ names: (m[1] || '').replace(/[{}]/g, '').split(',').map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean), spec: m[2] }));
}
function closure(entry) {
  const seen = new Set(), q = [entry];
  while (q.length) {
    const f = q.pop();
    if (seen.has(f) || !existsSync(f)) continue;
    seen.add(f);
    for (const im of importsOf(f)) q.push(resolve(dirname(f), im.spec));
  }
  return [...seen];
}
function parseCensus() {
  const svcFile = join(SRC, 'services.js');
  const txt = readFileSync(svcFile, 'utf8');
  const idMap = new Map();
  for (const im of importsOf(svcFile)) {
    if (!/\/(engine|adapters)\//.test(im.spec)) continue;           // config/util are not evidence of a venue read
    for (const n of im.names) idMap.set(n, resolve(dirname(svcFile), im.spec));
  }
  const marks = [...txt.matchAll(/^\s{4}name:\s*'([a-z0-9-]+)'/gm)].map((m) => ({ name: m[1], i: m.index }));
  return marks.map((mk, k) => {
    const slice = txt.slice(mk.i, k + 1 < marks.length ? marks[k + 1].i : txt.length);
    const files = new Set();
    for (const [id, mod] of idMap) if (new RegExp(`\\b${id}\\b`).test(slice)) for (const f of closure(mod)) files.add(f);
    const adapters = [...files].filter((f) => f.replace(/\\/g, '/').includes('/src/adapters/'));
    const fetchers = [...files].filter((f) => /\bfetch\s*\(/.test(readFileSync(f, 'utf8')));
    return {
      name: mk.name,
      shipsObservation: /observationEnvelope\(/.test(slice),
      shipsProof: /proofEnvelope\(/.test(slice),
      contactsHost: adapters.length > 0 || fetchers.length > 0,
      adapters: adapters.map((f) => f.split(/[\\/]/).pop()).sort(),
    };
  });
}
const CENSUS = parseCensus();
const byName = (n) => CENSUS.find((c) => c.name === n);

/* ══════════════════════════════ D4.1  the register is complete ══════════════════════════════ */

test('D4.1 every service is classified exactly once, and nothing extra is', () => {
  const live = SERVICES.map((s) => s.name).sort();
  const reg = Object.keys(INPUT_ATTESTATION).sort();
  assert.deepEqual(reg, live,
    'the input-attestation register must name exactly the services that exist. A new service missing from it must fail the gate, not inherit a silent default.');
  assert.equal(new Set(reg).size, reg.length, 'no duplicate entries');
});

test('D4.1 the census parsed from source matches the register, service by service', () => {
  assert.equal(CENSUS.length, 22, 'services.js must still yield 22 parsed service blocks');
  const wrong = [];
  for (const c of CENSUS) {
    const e = INPUT_ATTESTATION[c.name];
    const registerSaysContacts = (e.hosts || []).length > 0;
    if (registerSaysContacts !== c.contactsHost) {
      wrong.push(`${c.name}: register hosts=${JSON.stringify(e.hosts)} but source ${c.contactsHost ? 'DOES' : 'does NOT'} reach an adapter or fetch (${c.adapters.join(',') || 'none'})`);
    }
    // A service that contacts nothing cannot need input attestation, and one that does cannot be
    // classified not-needed. This is the pair of implications the whole register rests on.
    if (!c.contactsHost && e.category !== CATEGORY.NOT_NEEDED) wrong.push(`${c.name}: contacts nothing yet is classified ${e.category}`);
    if (c.contactsHost && e.category === CATEGORY.NOT_NEEDED) wrong.push(`${c.name}: contacts ${c.adapters.join(',')} yet is classified not-needed`);
  }
  assert.deepEqual(wrong, [], `register and source disagree:\n  ${wrong.join('\n  ')}`);
});

test('D4.1 the measured census still holds: 14 contact a host, 15 can ship an observation, 1 contacts nothing', () => {
  // These are PHASE_D_RESEARCH.md §1's numbers, re-derived here rather than quoted. They are the
  // denominators every coverage claim in that document divides by; if one moves, the coverage
  // sentences elsewhere are stale and somebody has to say so.
  assert.equal(CENSUS.filter((c) => c.contactsHost).length, 14, 'services that can contact an external host');
  assert.equal(CENSUS.filter((c) => c.shipsObservation).length, 15, 'services that can ship an observation envelope');
  assert.equal(CENSUS.filter((c) => c.shipsObservation && !c.contactsHost).map((c) => c.name).join(','), 'macro-sentry',
    'exactly one service ships an observation while contacting nothing, and it is macro-sentry');
  assert.equal(CENSUS.filter((c) => c.shipsObservation && c.shipsProof).map((c) => c.name).sort().join(','), 'perp-gate,portfolio-gate',
    'exactly two services branch between proof and observation at runtime');
});

test('D4.1 the category counts are the measured ones, and the eight are the named eight', () => {
  assert.deepEqual(census(), EXPECTED_CENSUS,
    'reclassifying a service without changing this expectation is exactly the silent claim inflation D4 exists to stop');
  // PHASE_D_RESEARCH.md §5 says ten have no mechanism. Measured, it is eight: poly-desk reads only
  // Polygon chain state and protocol-pulse has a measured path for a subset. Both moves are recorded
  // in src/util/inputClaims.js with the measurement that forced them.
  assert.deepEqual(servicesIn(CATEGORY.NONE), [
    'chart-press', 'loop-digest', 'options-desk', 'poly-fill',
    'tape-pulse', 'token-scan', 'updown-pulse', 'wallet-audit',
  ], 'the services measured as having no mechanism');
  assert.deepEqual(servicesIn(CATEGORY.AVAILABLE), ['perp-gate', 'portfolio-gate']);
  assert.deepEqual(servicesIn(CATEGORY.UNBUILT), ['calldata-x', 'lp-desk', 'poly-desk']);
  assert.deepEqual(servicesIn(CATEGORY.PARTIAL), ['protocol-pulse']);
});

test('D4.1 a partial mechanism names its subset and what falls outside it', () => {
  for (const name of servicesIn(CATEGORY.PARTIAL)) {
    const e = INPUT_ATTESTATION[name];
    assert.ok(e.subset && e.subset.length > 30, `${name}: PARTIAL with no subset named is the general-case overstatement wearing a smaller hat`);
    assert.ok(e.outsideSubset && e.outsideSubset.length > 30, `${name}: PARTIAL must say what falls outside`);
    assert.ok((e.gaps || []).length > 0, `${name}: PARTIAL must list gaps`);
  }
});

test('D4.1 the corrected rows carry the measurement that corrected them', () => {
  // A category that moved without evidence in the file is a category that moved because somebody
  // wanted it to. Each of these three rows was wrong on the first draft and each now has to show why.
  const e = INPUT_ATTESTATION;
  assert.equal(e['poly-desk'].category, CATEGORY.UNBUILT);
  assert.match(e['poly-desk'].mechanism, /eth_getProof on Polygon/);
  assert.match(e['poly-desk'].reason, /never touches the resting book/);
  assert.equal(e['protocol-pulse'].category, CATEGORY.PARTIAL);
  assert.match(e['protocol-pulse'].outsideSubset, /7,937/);
  assert.ok((e['perp-gate'].availableButUnwired || []).some((g) => /PremSamples/.test(g)),
    'dYdX funding is in the store under PremSamples and the register must say so rather than repeat "not located in either store"');
  assert.ok(e['perp-gate'].gaps.some((g) => /HYPERLIQUID/.test(g) && /time average/.test(g)),
    'Hyperliquid funding is still absent, and the register must give the structural reason rather than a failed search');
});

test('D4.1 every classification carries its evidence, and every mechanism carries its gaps', () => {
  const thin = [];
  for (const [name, e] of Object.entries(INPUT_ATTESTATION)) {
    if (e.category === CATEGORY.AVAILABLE) {
      if (!e.mechanism) thin.push(`${name}: claims a mechanism and does not name it`);
      if (!(e.covers || []).length) thin.push(`${name}: names no covered quantity`);
      if (!(e.gaps || []).length) thin.push(`${name}: an attestation with no stated gap is the overstatement this gate exists to catch`);
    } else if (!e.reason || e.reason.length < 30) {
      thin.push(`${name}: category ${e.category} with no substantive reason on record`);
    }
  }
  assert.deepEqual(thin, [], thin.join('\n'));
});

test('D4.1 the OKX rows record the measured re-fetch position, not the one §5 asserted', () => {
  // §5 calls the keyed OKX five the worst case because a buyer cannot re-fetch without HMAC
  // credentials. Measured with no credentials, five of the seven endpoints these services call return
  // HTTP 402 with x402 pay-per-use at $0.0001 to $0.0002, one 404s, and exactly ONE is credential
  // locked. The register has to hold the measured position, and the gate has to hold the register to
  // it, or a false reason survives inside a file whose whole job is being right about reasons.
  const keyed = Object.entries(INPUT_ATTESTATION).filter(([, e]) => e.keyed).map(([n]) => n).sort();
  assert.deepEqual(keyed, ['loop-digest', 'tape-pulse', 'token-scan', 'wallet-audit']);
  for (const k of keyed) {
    assert.equal(INPUT_ATTESTATION[k].category, CATEGORY.NONE, 'a re-fetch is not an attestation, so the category does not move');
    assert.ok(INPUT_ATTESTATION[k].refetch, `${k}: the measured re-fetch position must be on record`);
    assert.doesNotMatch(INPUT_ATTESTATION[k].reason, /go look yourself|cannot re-fetch|does not exist/,
      `${k}: the reason still repeats the claim that measurement refuted`);
  }
  assert.match(INPUT_ATTESTATION['loop-digest'].refetch, /^NO\./, 'loop-digest is the one genuinely credential-locked service');
  for (const k of ['tape-pulse', 'token-scan', 'wallet-audit', 'chart-press']) {
    assert.match(INPUT_ATTESTATION[k].refetch, /yes/i, `${k}: measured re-fetchable via x402`);
  }
});

/* ══════════════════════════════ D4.2  no false claim in a real envelope ══════════════════════════════ */

const sampleResult = (name) => ({
  ok: true, service: name, live: { source: 'upstream', fetchedAt: new Date().toISOString() },
  numbers: { a: 1.23, b: 4.56 }, checks: [{ name: 'shape', pass: true }],
});

test('D4.2 the ten no-mechanism services ship envelopes with no input-attestation claim', () => {
  const bad = [];
  for (const name of servicesIn(CATEGORY.NONE)) {
    const env = observationEnvelope(name, { q: 1 }, sampleResult(name), 'gate-d4');
    for (const f of scanEnvelope(env)) bad.push(`${name}${f.path}: ${f.why} (${f.matched})`);
  }
  assert.deepEqual(bad, [], `an envelope from a service with no attestation mechanism made an attestation-flavoured claim:\n  ${bad.join('\n  ')}`);
});

test('D4.2 the same holds for the two unbuilt ones and for a deterministic proof envelope', () => {
  const bad = [];
  for (const name of servicesIn(CATEGORY.UNBUILT)) {
    for (const f of scanEnvelope(observationEnvelope(name, { q: 1 }, sampleResult(name), 'gate-d4'))) bad.push(`${name}${f.path}: ${f.why}`);
  }
  for (const name of servicesIn(CATEGORY.NOT_NEEDED)) {
    const r = { ok: true, checks: [{ name: 'invariant', pass: true }] };
    for (const f of scanEnvelope(proofEnvelope(name, { q: 1 }, r, 'gate-d4'))) bad.push(`${name}${f.path}: ${f.why}`);
  }
  assert.deepEqual(bad, [], bad.join('\n'));
});

// The T1 signer is read once at module scope from the environment, so measuring the signed envelope
// needs a second process. Doing it properly matters: exempting the signature paths from the check
// "because we cannot see them from here" is how an allowlist quietly acquires a wing nobody has read.
function envelopeClaimPathsUnderT1() {
  const script = `
    import { proofEnvelope, observationEnvelope } from '${pathToFileURL(join(SRC, 'engine', 'proof.js')).href}';
    import { scanClaims } from '${pathToFileURL(join(SRC, 'util', 'inputClaims.js')).href}';
    const r = { ok: true, live: { source: 'u' }, checks: [{ name: 'x', pass: true }] };
    const paths = new Set();
    for (const e of [observationEnvelope('options-desk', { c: 1 }, r, 'g'),
                     proofEnvelope('size-gate', { c: 1 }, { ok: true, checks: [{ name: 'x', pass: true }] }, 'g')])
      for (const h of scanClaims(e)) paths.add(h.path);
    console.log(JSON.stringify([...paths]));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: ROOT, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, QUIVER_SIGNING_KEY: '0x' + '11'.repeat(32) },
  });
  const line = (r.stdout || '').trim().split('\n').pop();
  if (!line || !line.startsWith('[')) throw new Error(`could not measure the T1 envelope: ${r.stderr || r.stdout}`);
  return JSON.parse(line);
}

test('D4.2 the envelope allowlist is exactly the paths measured in a real envelope, no wider', () => {
  // An allowlist that grows to silence a failure is the same defect wearing a different hat. So the
  // allowlist is checked against what the real builders actually emit at BOTH tiers: every entry must
  // be reachable, and nothing outside it may carry the vocabulary. The first draft of this allowlist
  // had three dead entries and this assertion is what found them.
  const seen = new Set();
  for (const env of [
    observationEnvelope('options-desk', { c: 1 }, sampleResult('options-desk'), 'g'),
    proofEnvelope('size-gate', { c: 1 }, { ok: true, checks: [{ name: 'x', pass: true }] }, 'g'),
  ]) for (const h of scanClaims(env)) seen.add(h.path);
  for (const p of envelopeClaimPathsUnderT1()) seen.add(p);

  const unreachable = [...ENVELOPE_CLAIM_ALLOWLIST].filter((p) => !seen.has(p));
  assert.deepEqual(unreachable, [],
    `these allowlist paths are not produced by any real envelope at T0 or T1, so they are dead permissions: ${unreachable.join(', ')}`);
  const outside = [...seen].filter((p) => !ENVELOPE_CLAIM_ALLOWLIST.has(p));
  assert.deepEqual(outside, [], `attestation vocabulary appeared outside the allowlist: ${outside.join(', ')}`);
});

/* ══════════════════════════════ D4.3  the scanner can catch things ══════════════════════════════ */

test('D4.3 the scanner catches an attestation claim in twelve shapes', () => {
  const injections = [
    ['top-level key', { inputAttestation: { ok: true } }],
    ['nested key', { meta: { deep: { attestedInputs: ['markPrice'] } } }],
    ['key inside an array element', { items: [{ n: 1 }, { stateProof: '0xdead' }] }],
    ['camelCase variant', { venueProof: 'x' }],
    ['prose at the top level', { note: 'the mark price is attested against the venue' }],
    ['prose nested three deep', { a: { b: { c: 'cryptographically verified upstream read' } } }],
    ['prose inside an array of strings', { notes: ['fine', 'proof of input included'] }],
    ['a claim in a summary line', { summary: 'Deribit IV surface, attestation attached' }],
    ['the word attests', { how: 'the venue attests to this figure' }],
    ['certified', { grade: 'certified market data' }],
    ['confirms the price', { verdict: 'this confirms the price we used' }],
    ['a key that only contains the pattern', { extraAttestationBlob: 1 }],
  ];
  const missed = injections.filter(([, v]) => scanClaims(v).length === 0).map(([label]) => label);
  assert.deepEqual(missed, [], `the scanner missed: ${missed.join(', ')}`);
});

test('D4.3 the scanner does NOT fire on honest wording', () => {
  // The half that can fail. A scanner that flags everything would force the allowlist to swallow the
  // whole envelope, and then D4 would be green forever regardless of what anyone shipped.
  const honest = [
    { divergence: { spreadBps: 9.9, isAttestation: false, sources: ['okx_index', 'deribit_index'] } },
    { note: 'this is a committed observation of a live upstream, not re-runnable' },
    { note: 'recompute contentHash to detect tampering' },
    { live: { source: 'api.hyperliquid.xyz', fetchedAt: '2026-07-28T00:00:00Z' } },
    { checks: [{ name: 'liquidation identity', pass: true }] },
  ];
  const fired = honest.filter((v) => scanClaims(v).length > 0);
  assert.deepEqual(fired.map((v) => Object.keys(v)[0]), [], 'the scanner fired on honest wording');
});

test('D4.3 a denial is not a claim, and a claim hiding behind a denial is still a claim', () => {
  // This test exists because the first run of D4 went red on this stack's own honest output. Both
  // directions are asserted, because fixing only the first direction would have produced a scanner
  // that any sentence containing the word "not" could walk straight past.
  const denials = [
    { isAttestation: false },
    { note: 'This is a disclosure, not an attestation.' },
    { note: 'the input is not attested and cannot be' },
    { note: 'no mechanism attests this input' },
    { limits: ['It is not a T1 signature, not a consensus read, and not a state proof.'] },
  ];
  const wronglyFired = denials.filter((v) => scanClaims(v).length > 0);
  assert.deepEqual(wronglyFired, [], `the scanner read a denial as a claim: ${JSON.stringify(wronglyFired)}`);

  const sneaky = [
    ['a claim in the sentence after a denial', { note: 'This is not a signature. The input is attested against the venue.' }],
    ['a claim after a semicolon', { note: 'no signature here; the venue attests to this figure' }],
    ['a truthy key that a false one would have excused', { isAttestation: true }],
    ['an object-valued attestation key', { inputAttestation: { markPrice: 1 } }],
  ];
  const missed = sneaky.filter(([, v]) => scanClaims(v).length === 0).map(([l]) => l);
  assert.deepEqual(missed, [], `the scanner was walked past by: ${missed.join(', ')}`);
});

test('D4.3 the correctness scanner is a separate instrument and catches its own vocabulary', () => {
  assert.ok(scanCorrectnessClaims({ meaning: 'the sources agree, which proves correct pricing' }).length > 0);
  assert.equal(scanCorrectnessClaims({ meaning: 'the sources disagree by 9.9 bps, which says nothing about correctness' }).length, 0);
});

/* ══════════════════════════════ D4.4  the chokepoint refuses ══════════════════════════════ */

const deribitEnvelope = () => observationEnvelope('options-desk', { currency: 'BTC' }, sampleResult('options-desk'), 'gate-d4');

test('D4.4 the exact edit the research names: an attestation field on a Deribit answer is REFUSED', () => {
  const env = deribitEnvelope();
  assert.throws(
    () => attachSibling(env, 'inputAttestation', { venue: 'deribit', markIv: 0.55 }, { service: 'options-desk' }),
    InputClaimError,
    'attaching an attestation field to a Deribit answer must be refused, in code, not in a comment');
  // And with the flag set, because the flag is not a password.
  assert.throws(
    () => attachSibling(env, 'inputAttestation', { venue: 'deribit' }, { service: 'options-desk', allowAttestation: true }),
    /no attestation mechanism/,
    'asking nicely must not work either');
});

test('D4.4 refused for every no-mechanism service, in prose as well as in a field name', () => {
  const refused = [];
  for (const name of servicesIn(CATEGORY.NONE)) {
    const env = observationEnvelope(name, { q: 1 }, sampleResult(name), 'g');
    for (const [key, val] of [
      ['inputAttestation', { ok: true }],
      ['provenance', { note: 'this input is attested against the venue' }],
      ['sourceCheck', { detail: ['ordinary', 'proof of input attached'] }],
    ]) {
      let threw = false;
      try { attachSibling(env, key, val, { service: name, allowAttestation: true }); } catch (e) { threw = e instanceof InputClaimError; }
      if (!threw) refused.push(`${name} accepted ${key}`);
    }
  }
  assert.deepEqual(refused, [], refused.join('\n'));
});

test('D4.4 permitted only where a mechanism was measured, and only when the sibling names its gaps', () => {
  const env = observationEnvelope('perp-gate', { symbol: 'BTC' }, sampleResult('perp-gate'), 'g');
  assert.ok(mayCarryInputAttestation('perp-gate'));
  // A bare claim is still refused for the service that CAN attest. This is the "guarantee stated over
  // the general case that holds only over a subset" defect, refused in code.
  assert.throws(
    () => attachSibling(env, 'inputAttestation', { markPrice: 63396, source: 'markPx precompile' }, { service: 'perp-gate', allowAttestation: true }),
    /must carry its own `gaps` array/);
  // With its gaps declared it is allowed through.
  const ok = attachSibling(env, 'inputAttestation', {
    markPrice: 63396, source: 'markPx(uint32) precompile 0x…0806',
    gaps: ['fundingRateHourly: no precompile exists', 'marginTiers: marginTableId exposed, table is not'],
  }, { service: 'perp-gate', allowAttestation: true });
  assert.ok(ok.inputAttestation, 'the honest case must still be possible, or the gate is just a ban');
});

/* The other half of a negative gate, and the half that is easy to forget: it must not block the
 * edits that are CORRECT. A gate that refuses everything is indistinguishable from a gate that
 * refuses the right things, and would quietly stop the work it was built to protect. These three
 * tests exist because the concern was raised explicitly, and an assertion that "it would not block
 * that" is worth nothing next to a test that performs the edit. */

test('D4.4 does NOT block the OKX re-fetch disclosure, which is a correct edit', () => {
  // Measured: five of seven OKX DEX endpoints serve x402 pay-per-use with no credentials. Disclosing
  // that is honest and is not an attestation, so it must attach cleanly to all five services today.
  const blocked = [];
  for (const name of ['tape-pulse', 'token-scan', 'wallet-audit', 'loop-digest', 'chart-press']) {
    const env = observationEnvelope(name, { chain: 'ethereum' }, sampleResult(name), 'g');
    const sibling = {
      kind: 'REFETCH_DISCLOSURE',
      note: 'A credential-less buyer can re-fetch this from the same endpoint via x402 pay-per-use.',
      endpoint: 'https://web3.okx.com/api/v6/dex/market/trades',
      priceUsd: 0.0001, asset: '0x4ae46a509f6b1d9056937ba4500cb143933d2dc8', network: 'eip155:196',
      limits: ['A re-fetch is a concurrent check, not an audit: the market moves. The response is unsigned either way.'],
    };
    try {
      const out = attachSibling(env, 'refetch', sibling, { service: name });
      assert.equal(out.observation.contentHash, env.observation.contentHash);
    } catch (e) { blocked.push(`${name}: ${e.message}`); }
  }
  assert.deepEqual(blocked, [], `D4 blocked a correct edit:\n  ${blocked.join('\n  ')}`);
});

test('D4.4 does NOT block a Polygon state-proof sibling for poly-desk', () => {
  // poly-desk's positions are Conditional Tokens storage and eth_getProof works on Polygon, measured
  // at about 7.2 KB. Attaching the PROOF as data is correct; the entry is UNBUILT, so calling it an
  // attestation is not, and both halves are asserted here.
  const env = observationEnvelope('poly-desk', { wallet: '0x0' }, sampleResult('poly-desk'), 'g');
  const out = attachSibling(env, 'chainAnchor', {
    kind: 'CHAIN_ANCHOR', chain: 'polygon', contract: '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045',
    blockNumber: 91026673, accountProofNodes: 9, storageProofNodes: 7, bytes: 7154,
    note: 'The block state these positions were read against. Verifying it is left to the caller and nothing here has done it.',
  }, { service: 'poly-desk' });
  assert.ok(out.chainAnchor, 'attaching the anchor as data must be permitted');
  assert.throws(
    () => attachSibling(env, 'inputAttestation', { verified: true, gaps: ['x'] }, { service: 'poly-desk', allowAttestation: true }),
    /no attestation mechanism/,
    'until it is built and measured, calling it an attestation is still premature');
});

test('D4.4 the ratchet has a documented release: promote the entry and the claim is permitted', () => {
  // If a gate can only ever tighten it will eventually be deleted. Promoting poly-desk to AVAILABLE,
  // with a mechanism and gaps on record, must make the attestation attachable. That is the workflow
  // the gate enforces: measure, record, then claim.
  const promoted = {
    ...INPUT_ATTESTATION,
    'poly-desk': {
      category: CATEGORY.AVAILABLE, hosts: INPUT_ATTESTATION['poly-desk'].hosts,
      mechanism: 'eth_getProof on Polygon against the Conditional Tokens contract',
      covers: ['position balances'],
      gaps: ['the resting book, which never touches a chain', 'market metadata served by gamma'],
    },
  };
  const env = observationEnvelope('poly-desk', { wallet: '0x0' }, sampleResult('poly-desk'), 'g');
  const out = attachSibling(env, 'inputAttestation', {
    positions: 3, root: '0xabc', gaps: ['the resting book is not covered by this'],
  }, { service: 'poly-desk', allowAttestation: true, registry: promoted });
  assert.ok(out.inputAttestation);
});

test('D4.4 a PARTIAL mechanism must name its subset as well as its gaps', () => {
  const env = observationEnvelope('protocol-pulse', { protocol: 'aave' }, sampleResult('protocol-pulse'), 'g');
  // gaps alone is not enough for a partial mechanism
  assert.throws(
    () => attachSibling(env, 'inputAttestation', { tvl: 11.4e9, gaps: ['the counting convention'] }, { service: 'protocol-pulse', allowAttestation: true }),
    /must carry a `subset` string/);
  const out = attachSibling(env, 'inputAttestation', {
    tvl: 11.4e9,
    subset: 'aave-v3 on Ethereum only, recomputed from 67 of 67 reserves; no other protocol is covered by this figure',
    gaps: ['the other 7,937 protocols', 'the counting convention itself'],
  }, { service: 'protocol-pulse', allowAttestation: true });
  assert.ok(out.inputAttestation.subset);
});

test('D4.4 an unknown service fails closed', () => {
  assert.throws(() => attachSibling(deribitEnvelope(), 'x', { a: 1 }, { service: 'a-service-added-yesterday' }), /fails closed/);
});

test('D4.4 the hashed part of the envelope cannot be reached through the chokepoint', () => {
  const env = deribitEnvelope();
  const before = env.observation.contentHash;
  assert.throws(() => attachSibling(env, 'observation', { anything: 1 }, { service: 'options-desk' }), /hashed part/);
  assert.throws(() => attachSibling(env, 'proof', { anything: 1 }, { service: 'options-desk' }), /hashed part/);
  const out = attachSibling(env, 'divergence', { kind: 'DIVERGENCE_DISCLOSURE', spreadBps: 9.9 }, { service: 'options-desk' });
  assert.equal(out.observation, env.observation, 'the hashed sub-object must be the same reference, not a copy');
  assert.equal(out.observation.contentHash, before);
  assert.equal(env.divergence, undefined, 'the input envelope must not be mutated');
  // and the hash still recomputes over exactly what it covered before
  const { observation, divergence, ...result } = out;
  const recomputed = _internal.sha256(_internal.canonical({
    engine: observation.engine, codeHash: observation.codeHash, observedAtUtc: observation.observedAtUtc,
    inputs: observation.inputs, result: _internal.jsonClean(result),
  }));
  assert.equal(recomputed, before, 'attaching a sibling must leave the published contentHash recomputable');
});

/* ══════════════════════════════ D4.5  fabricated input, no confident answer ══════════════════════════════ */

test('D4.5 a tampered result breaks its own content hash', () => {
  const env = observationEnvelope('options-desk', { currency: 'BTC' }, sampleResult('options-desk'), 'g');
  const { observation, ...result } = env;
  result.numbers.a = 9.99;                                   // the fabrication
  const recomputed = _internal.sha256(_internal.canonical({
    engine: observation.engine, codeHash: observation.codeHash, observedAtUtc: observation.observedAtUtc,
    inputs: observation.inputs, result: _internal.jsonClean(result),
  }));
  assert.notEqual(recomputed, observation.contentHash, 'a tampered result must not still hash to the published value');
});

// Fixtures rather than live reads, so this half is deterministic and can be reasoned about. The live
// half lives in gateDiv-disclosure.mjs.
const CAL = {
  _meta: { statistic: 'p95 of independentSpreadBps across rounds', measuredOnUtc: '2026-07-28T00:00:00Z', script: 'gates/calibrate-divergence.mjs' },
  BTC: { native: { floorBps: 11, rounds: 100 } },
};
const readingsAt = (vals) => Object.entries(vals).map(([source, value]) => ({ source, value, host: SOURCES[source].host, basis: SOURCES[source].basis, ms: 1 }));
const HONEST = { hyperliquid_mark: 63478, hyperliquid_oracle: 63496, dydx_oracle: 63453, okx_index: 63433, okx_spot: 63495, deribit_index: 63430 };

test('D4.5 a fabrication BELOW the floor is reported as undetectable, never as agreement', () => {
  // The dangerous case, and the reason this gate exists at all. Move one source by 3 bps: the
  // disclosure still reads WITHIN_FLOOR. It must therefore not say anything that a reader converts
  // into confidence, and it must state its own blindness in its own output.
  const bent = { ...HONEST, hyperliquid_mark: HONEST.hyperliquid_mark * 1.0003 };
  const d = buildDisclosure({ symbol: 'BTC', readings: readingsAt(bent), calibration: CAL });
  assert.equal(d.status, 'DISCLOSED');
  assert.equal(d.verdict, 'WITHIN_FLOOR', 'a 3 bps fabrication is inside the honest band by construction');
  assert.equal(d.isAttestation, false);
  assert.equal(d.confirmsCorrectness, false);
  assert.match(d.meaning, /says NOTHING about whether the number is correct/);
  assert.match(d.floorProvenance.meaning, /INVISIBLE to this check/);
  assert.deepEqual(scanCorrectnessClaims(d), [], 'a WITHIN_FLOOR disclosure must not contain a correctness claim');
  assert.deepEqual(scanClaims(d), [], 'and must not contain an attestation claim');
});

test('D4.5 a fabrication above the floor is disclosed, and still does not name a culprit', () => {
  const bent = { ...HONEST, hyperliquid_mark: HONEST.hyperliquid_mark * 1.005 };  // 50 bps
  const d = buildDisclosure({ symbol: 'BTC', readings: readingsAt(bent), calibration: CAL });
  assert.equal(d.verdict, 'ABOVE_FLOOR');
  assert.match(d.meaning, /cannot say which source is wrong/);
  assert.deepEqual(scanCorrectnessClaims(d), []);
});

test('D4.5 one source is refused outright, and no zero spread is published', () => {
  const d = buildDisclosure({ symbol: 'BTC', readings: readingsAt({ okx_index: 63433 }), calibration: CAL });
  assert.equal(d.status, 'REFUSED');
  assert.equal(d.spreadBps, undefined, 'publishing a zero spread over one source would read as perfect agreement');
  assert.equal(d.verdict, undefined);
  assert.match(d.reason, /would read as agreement/);
});

test('D4.5 two readings from one host are refused as one source', () => {
  const d = buildDisclosure({ symbol: 'BTC', readings: readingsAt({ hyperliquid_mark: 63478, hyperliquid_oracle: 63496 }), calibration: CAL });
  assert.equal(d.status, 'REFUSED');
  assert.match(d.reason, /one HTTP response are one source/);
  assert.equal(d.independentSpreadBps, undefined);
});

test('D4.5 an uncalibrated symbol is refused rather than given an invented floor', () => {
  const d = buildDisclosure({ symbol: 'BTC', readings: readingsAt(HONEST), calibration: { _meta: CAL._meta } });
  assert.equal(d.status, 'REFUSED');
  assert.match(d.reason, /no measured honest-disagreement floor/);
});

test('D4.5 the shipped FLOOR is calibrated, and every calibrated entry carries its provenance', () => {
  // The instrument that caught a bound nine orders of magnitude too wide was a metric reading exactly
  // 0.0% on every sample. This is the equivalent tripwire: an uncalibrated or zero floor would make
  // every disclosure read ABOVE_FLOOR or WITHIN_FLOOR for no measured reason.
  assert.ok(FLOOR._meta.measuredOnUtc, 'FLOOR is uncalibrated; src/util/divergence.js still carries the placeholder');
  const symbols = Object.keys(FLOOR).filter((k) => k !== '_meta');
  assert.ok(symbols.length > 0, 'no symbol is calibrated');
  for (const s of symbols) {
    for (const [set, v] of Object.entries(FLOOR[s])) {
      assert.ok(Number.isFinite(v.floorBps) && v.floorBps > 0, `${s}/${set}: floor must be a positive measured number`);
      assert.ok(v.rounds >= 50, `${s}/${set}: ${v.rounds} rounds is not a distribution`);
    }
  }
});

test('D4.5 the divergence sibling reaches the envelope through the chokepoint and claims nothing', () => {
  const env = observationEnvelope('options-desk', { currency: 'BTC' }, sampleResult('options-desk'), 'g');
  const d = buildDisclosure({ symbol: 'BTC', readings: readingsAt(HONEST), calibration: CAL });
  const out = withDivergenceDisclosure(env, d, { service: 'options-desk' });
  assert.equal(out.divergence.status, 'DISCLOSED');
  assert.equal(out.observation.contentHash, env.observation.contentHash);
  assert.deepEqual(scanEnvelope(out), [], 'attaching a disclosure must not introduce a claim anywhere in the envelope');
});
