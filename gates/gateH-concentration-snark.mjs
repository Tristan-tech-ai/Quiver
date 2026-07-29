// GATE H — the Herfindahl proof is reachable from `treasury-risk`, it is about the book that was
// priced, and it can still say no.
//
// THE THIRD CIRCUIT ACROSS THE FENCE, and the first whose inputs are not the caller's. `kelly.circom`
// takes a probability and a ratio, both typed by whoever asked. `concentration.circom` takes the
// SHARES, which the engine forms by grouping the book by asset and dividing by the total. Two
// consequences run through everything here:
//
//   • THE GROUPING MUST BE THE ENGINE'S. A book with two USDC positions has ONE USDC share. An
//     encoder that formed one share per POSITION would certify a book with a different concentration
//     than the one that was priced, and it would agree with itself perfectly while doing it. There is
//     no encoder for this circuit under `zk/scripts/lib/` at all; the sweep gate that proves the
//     circuit re-derives weights per position, which is sound only because its own generator gives
//     each asset exactly one position. H.3 is built the other way round on purpose — most of its
//     books repeat assets, so an encoder that skipped the grouping fails on the first one.
//   • NO SNAP CAN PUT A QUOTIENT ON THE GRID. `vᵢ/T` lands where the division lands however carefully
//     the request was written, so the guard's encoding term carries a full half step per share rather
//     than the half ulp a snapped input costs. That is the same situation as the liquidation margin
//     derived from leverage, and it is why the bound here is measured over 2^N corners.
//
//   node --test gates/gateH-concentration-snark.mjs     # fully offline
//   node gates/gateH-revert.mjs                         # five scripted defects, each must turn it red
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { treasuryRisk } from '../src/engine/treasuryRisk.js';
import { round } from '../src/engine/stats.js';
import { concentrationWitnessFor, buildConcentrationInBackground, getProof, stopProver, verificationKey, _internalHhi } from '../src/util/snark.js';
import { byName } from '../src/services.js';
import { handleRpc } from '../src/mcp.js';
import { followPublishedRecipe } from '../src/util/recipe.js';

const require = createRequire(import.meta.url);
const scale = require('../src/util/scale.cjs');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SYNTHETIC = Number(process.env.QUIVER_GATEH_SYNTHETIC || 20000);

after(async () => {
  try { await stopProver(); } catch { /* already gone */ }
  try { await globalThis.curve_bn128?.terminate(); } catch { /* never started */ }
});

const quantile = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

// A deterministic generator of books, weighted towards the shapes that break an encoder rather than
// the shapes that flatter one. Two thirds of them repeat at least one asset.
const ASSETS = ['USDC', 'USDT', 'DAI', 'PYUSD', 'FDUSD', 'USDE', 'GHO', 'CRVUSD'];
function* books(n) {
  let seed = 20260729;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const logu = (a, b) => Math.exp(Math.log(a) + rnd() * (Math.log(b) - Math.log(a)));
  for (let i = 0; i < n; i++) {
    const mode = i % 4;
    const groups = 1 + Math.floor(rnd() * 8);          // 1..8 distinct assets
    const legs = mode === 0 ? groups                    // one position per asset
      : groups + Math.floor(rnd() * 6);                 // repeats, so grouping matters
    const positions = [];
    for (let k = 0; k < legs; k++) {
      const asset = ASSETS[k < groups ? k : Math.floor(rnd() * groups)];
      // mode 2 spans magnitudes: a dust position beside a nine-figure one is where a share rounds hardest
      const amountUsd = mode === 2 ? logu(1e-6, 1e9) : mode === 3 ? logu(1, 1e4) : logu(1e3, 5e7);
      positions.push({ asset, amountUsd, venue: `v${k % 3}` });
    }
    yield { mode, positions };
  }
}

// ── H.1 the expression is the engine's, and that is checked by running the engine's own source ────

test('H.1 the index the guard compares against is the engine\'s expression, both folds', () => {
  const statsSrc = readFileSync(join(ROOT, 'src', 'engine', 'stats.js'), 'utf8');
  const scaleSrc = readFileSync(join(ROOT, 'src', 'util', 'scale.cjs'), 'utf8');

  // The engine's own two folds, lifted out of `hhi` by shape rather than by name.
  const body = (statsSrc.match(/export function hhi\(values\)\s*\{([\s\S]*?)\n\}/) || [])[1];
  assert.ok(body, 'src/engine/stats.js no longer states hhi as a function this gate can see');
  const engineTotal = (body.match(/const total = (.+);/) || [])[1];
  const engineSum = (body.match(/return (values\.reduce\(.+\));/) || [])[1];
  assert.ok(engineTotal && engineSum, 'hhi no longer states its two folds on their own lines');

  const copyBody = (scaleSrc.match(/function engineHerfindahl\(values\)\s*\{([\s\S]*?)\n\}/) || [])[1];
  assert.ok(copyBody, 'scale.cjs no longer states engineHerfindahl');
  const copyTotal = (copyBody.match(/const total = (.+);/) || [])[1];
  const copySum = (copyBody.match(/return (values\.reduce\(.+\));/) || [])[1];
  assert.equal(copyTotal, engineTotal, 'the total fold has drifted from the engine\'s');
  assert.equal(copySum, engineSum, 'the sum-of-squares fold has drifted from the engine\'s');

  // Not "they look the same": the engine's own source is compiled and required to return the identical
  // double. Re-associating a fold is the same class of defect as re-arranging an expression, and a
  // sum of eight doubles is not associative.
  const engineFn = new Function('values', body);
  let seed = 987654321;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const logu = (a, b) => Math.exp(Math.log(a) + rnd() * (Math.log(b) - Math.log(a)));
  let checked = 0;
  for (let i = 0; i < 100000; i++) {
    const n = 1 + Math.floor(rnd() * 8);
    const values = Array.from({ length: n }, () => logu(1e-6, 1e9));
    assert.ok(Object.is(engineFn(values), scale.engineHerfindahl(values)),
      `the copy and the engine's own hhi disagree at ${JSON.stringify(values)}`);
    // And the shares split out of it fold back to exactly the same double — the claim that lets the
    // circuit take shares while the engine takes amounts.
    const shares = scale.engineShares(values);
    const refolded = shares.reduce((acc, w) => acc + w ** 2, 0);
    assert.ok(Object.is(refolded, scale.engineHerfindahl(values)),
      `folding the split shares does not reproduce the engine's index at ${JSON.stringify(values)}`);
    checked++;
  }
  assert.equal(checked, 100000, 'the sweep did not run — this assertion proved nothing');
});

test('H.2 the display rounding the guard asks about is the engine\'s own', () => {
  let seed = 24681357;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  let checked = 0;
  for (let i = 0; i < 200000; i++) {
    // Weighted onto the 4dp boundaries, the only place a difference could hide.
    const x = i % 3 === 0 ? (Math.round(rnd() * 2e4) + 1) / 2e4 : rnd();
    assert.ok(Object.is(_internalHhi.displayRound(x), round(x, 4)),
      `the guard rounds ${x} to ${_internalHhi.displayRound(x)}; the engine displays it as ${round(x, 4)}`);
    checked++;
  }
  assert.equal(checked, 200000);
});

// ── H.3 the sweep, against the REAL engine, over books that repeat assets ─────────────────────────

test('H.3 the bound holds on a sweep run against the real engine, and the grouping is the engine\'s', () => {
  const rows = [];
  let repeated = 0;
  for (const { mode, positions } of books(SYNTHETIC)) {
    const r = treasuryRisk({ positions });
    if (r.ok !== true) continue;
    const w = concentrationWitnessFor({ positions }, r);
    if (!w) continue;
    const distinct = new Set(positions.map((p) => p.asset)).size;
    if (positions.length > distinct) repeated++;
    rows.push({
      mode, positions, groups: w.groups,
      distinct,
      roundsBack: _internalHhi.displayRound(w.engineIndex) === w.served,
      gapToEngine: w.gapToEngine, bound: w.encodingBound,
      used: w.gapToEngine / w.encodingBound,
      publishable: w.encodingBound <= _internalHhi.DISPLAY_HALF_UNIT,
      circuitHolds: (w.residual < 0n ? -w.residual : w.residual) * 2n <= w.tolerance,
      slackOk: w.weightSlack >= 0n && w.weightSlack <= 2n * BigInt(scale.CONCENTRATION_N),
    });
  }
  assert.ok(rows.length > SYNTHETIC * 0.4, `only ${rows.length} of ${SYNTHETIC} books produced a witness`);
  for (const mode of [0, 1, 2, 3]) {
    assert.ok(rows.some((r) => r.mode === mode), `mode ${mode} contributed nothing`);
  }

  // THE GROUPING. Most of this sweep repeats assets, and for every one of those the witness must
  // carry FEWER shares than the book has positions. An encoder that formed one share per position
  // would fail here on the first repeat rather than being caught by a customer.
  assert.ok(repeated > rows.length * 0.4,
    `only ${repeated} of ${rows.length} books repeat an asset — this sweep is not testing the grouping`);
  const misgrouped = rows.filter((r) => r.groups !== r.distinct);
  assert.equal(misgrouped.length, 0,
    `${misgrouped.length} books were encoded with a share count that is not the engine's group count, e.g. ${JSON.stringify(misgrouped[0]?.positions)}`);

  const missed = rows.filter((r) => !r.roundsBack);
  assert.equal(missed.length, 0, `${missed.length} books where the recomputation does not reproduce the engine`);

  const broken = rows.filter((r) => !r.circuitHolds || !r.slackOk);
  assert.equal(broken.length, 0, `${broken.length} witnesses would not satisfy concentration.circom's own constraints`);

  const over = rows.filter((r) => r.used > 1);
  assert.equal(over.length, 0,
    `${over.length} of ${rows.length} books exceed the bound they are certified under, e.g. ${over.slice(0, 2).map((r) => `${(r.used * 100).toFixed(2)}%`).join(' | ')}`);

  // A bound the worst honest case cannot approach is not a bound. This one is dominated by the single
  // grid rounding of Ĥ, so the worst book has to come close to consuming it.
  const used = rows.map((r) => r.used);
  assert.ok(Math.max(...used) >= 0.5,
    `the worst honest book uses only ${(Math.max(...used) * 100).toFixed(2)}% of the bound — it is measuring nothing`);

  // And it is not inflated: the encoding term must stay small against the one rounding that dominates.
  const medianBound = quantile(rows.map((r) => r.bound), 0.5);
  assert.ok(medianBound <= 8 * _internalHhi.HALF_STEP,
    `the median bound is ${medianBound.toExponential(3)}, ${(medianBound / _internalHhi.HALF_STEP).toFixed(1)}x the single grid rounding it should be`);

  // Every book here is publishable, and that is the honest shape of this circuit rather than a lucky
  // sweep: the index is displayed to four decimals and the encoding moves it by nanometres.
  assert.equal(rows.filter((r) => !r.publishable).length, 0,
    'a book was refused as unpinnable — the four-decimal display should leave five orders of magnitude of room');

  console.log(`  H.3  ${rows.length} books against the real engine, ${repeated} of them repeating an asset, 0 misgrouped`);
  console.log(`       worst ${(Math.max(...used) * 100).toFixed(3)}%, median ${(quantile(used, 0.5) * 100).toFixed(2)}%, p99 ${(quantile(used, 0.99) * 100).toFixed(2)}% of the bound`);
  console.log(`       bound: median ${medianBound.toExponential(2)} (${(medianBound / _internalHhi.HALF_STEP).toFixed(2)}x one grid rounding) against a ${_internalHhi.DISPLAY_HALF_UNIT} display half-unit`);
});

// ── H.4 / H.5 a real proof, through the service, and the half that can fail ───────────────────────

// Five positions, four assets — USDC appears twice, so a per-position encoder produces five shares
// and a different index. Shares land on 0.51 / 0.25 / 0.18 / 0.06 and the index on 0.3586 exactly,
// which makes a residual of anything but zero immediately suspicious.
const BOOK = { positions: [
  { asset: 'USDC', amountUsd: 4200000, apyPct: 4.5, venue: 'aave' },
  { asset: 'USDT', amountUsd: 2500000, apyPct: 5.1, venue: 'compound' },
  { asset: 'DAI', amountUsd: 1800000, apyPct: 3.9, venue: 'sky' },
  { asset: 'USDC', amountUsd: 900000, apyPct: 4.2, venue: 'morpho' },
  { asset: 'PYUSD', amountUsd: 600000, apyPct: 4.8, venue: 'aave' },
] };

let PROVEN = null;
async function proveThroughTheService() {
  if (PROVEN) return PROVEN;
  const env = await byName['treasury-risk'].run({ ...BOOK, snark: true });
  const deadline = Date.now() + 180_000;
  const recordBy = Date.now() + 10_000;
  for (;;) {
    const rec = await getProof(env.proof.contentHash);
    if (rec && rec.status === 'ready') { PROVEN = { env, rec }; return PROVEN; }
    if (!rec) {
      assert.ok(Date.now() < recordBy, 'the handler wrote no proof record within ten seconds');
      await new Promise((r) => setTimeout(r, 50));
      continue;
    }
    assert.notEqual(rec.status, 'unavailable', `the service refused to prove its own worked book: ${rec.error}`);
    assert.notEqual(rec.status, 'failed', `proving the worked book failed: ${rec.error}`);
    assert.ok(Date.now() < deadline, 'the proof never finished building');
    await new Promise((r) => setTimeout(r, 200));
  }
}

test('H.4 a proof built through the SERVICE verifies, and its signals are the engine\'s shares', async () => {
  const { env, rec } = await proveThroughTheService();
  const snarkjs = (await import('snarkjs')).default ?? (await import('snarkjs'));

  assert.equal(rec.circuit, 'concentration');
  assert.equal(env.snark.circuit, 'concentration');
  assert.equal(env.snark.verificationKey, '/proof/vk/concentration');
  assert.equal(env.snark.dimensionProven, 'byAsset');
  assert.equal(env.snark.assetsProven, 4, 'the response claims a share count that is not the engine\'s group count');

  const vk = verificationKey('concentration');
  assert.ok(vk && vk.protocol === 'plonk', 'no concentration verification key is published');
  assert.equal(await snarkjs.plonk.verify(vk, rec.publicSignals, rec.proof), true,
    'the honest proof does not verify against the published key');

  // Layout: [residual, tolerance, weightSlack, wHat[0..7], hHat].
  assert.equal(rec.publicSignals.length, 12, 'the concentration circuit publishes twelve signals; this is not it');
  const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
  const asInt = (x) => { const v = BigInt(x); return v > FIELD / 2n ? v - FIELD : v; };
  assert.equal(asInt(rec.publicSignals[0]), 0n, `the worked book should have an exact residual; it is ${asInt(rec.publicSignals[0])}`);
  assert.equal(BigInt(rec.publicSignals[1]), 1000000000n, 'the tolerance signal is not one grid step');
  const shares = rec.publicSignals.slice(3, 11).map(BigInt);
  // THE GROUPING, VISIBLE IN THE PROOF. Four non-zero shares for five positions, and USDC's is the
  // SUM of its two rows rather than either of them.
  assert.deepEqual(shares, [510000000n, 250000000n, 180000000n, 60000000n, 0n, 0n, 0n, 0n],
    'the shares in the proof are not the engine\'s grouped shares');
  assert.equal(BigInt(rec.publicSignals[11]), 358600000n, 'the index signal is not the index that was served');
  assert.equal(scale.fromScaled(BigInt(rec.publicSignals[11])), env.snark.indexProven);
  assert.equal(rec.gapToServedIndex, 0);

  console.log(`  H.4  5 positions -> 4 shares [0.51, 0.25, 0.18, 0.06] -> H ${env.snark.indexProven}; residual 0, 4 padded lanes`);
});

test('H.5 every perturbed public signal is rejected, and so is a bent proof', async () => {
  const { rec } = await proveThroughTheService();
  const snarkjs = (await import('snarkjs')).default ?? (await import('snarkjs'));
  const vk = verificationKey('concentration');

  let refused = 0;
  for (let i = 0; i < rec.publicSignals.length; i++) {
    const bad = [...rec.publicSignals];
    bad[i] = (BigInt(bad[i]) + 1n).toString();
    let accepted;
    try { accepted = await snarkjs.plonk.verify(vk, bad, rec.proof); } catch { accepted = false; }
    assert.equal(accepted, false, `signal[${i}] moved by one was ACCEPTED — this verifier cannot reject`);
    refused++;
  }
  assert.equal(refused, 12, 'not every signal was perturbed');

  const bent = JSON.parse(JSON.stringify(rec.proof));
  bent.A[0] = (BigInt(bent.A[0]) + 1n).toString();
  let bentAccepted;
  try { bentAccepted = await snarkjs.plonk.verify(vk, rec.publicSignals, bent); } catch { bentAccepted = false; }
  assert.equal(bentAccepted, false, 'a bent proof point was accepted');

  // The three keys must be genuinely different: neither sibling circuit's key may accept this proof.
  for (const other of ['liquidation', 'kelly']) {
    let crossAccepted;
    try { crossAccepted = await snarkjs.plonk.verify(verificationKey(other), rec.publicSignals, rec.proof); } catch { crossAccepted = false; }
    assert.notEqual(crossAccepted, true, `the ${other} key accepts a concentration proof — the circuits are not distinguishable`);
  }

  console.log('  H.5  12 of 12 perturbed signals rejected, bent proof rejected, both sibling keys reject it');
});

// ── H.6 the refusals ─────────────────────────────────────────────────────────────────────────────

test('H.6 a book the circuit cannot honestly speak about is refused, and says which reason', async () => {
  // (a) NINE ASSETS. The circuit is compiled for eight and the ninth share is REAL, so unlike a short
  //     book there is nothing padding can do. Refused by name, with the count.
  const nine = await byName['treasury-risk'].run({
    positions: Array.from({ length: 9 }, (_, i) => ({ asset: `S${i}`, amountUsd: 1000 * (i + 1) })),
    snark: true,
  });
  assert.equal(nine.snark.status, 'unavailable');
  assert.match(nine.snark.reason, /9 distinct assets/);
  assert.match(nine.snark.reason, /padding cannot help/);
  assert.equal('retrieveAt' in nine.snark, false);
  assert.equal(await getProof(nine.proof.contentHash), null, 'a nine-asset book queued a proof anyway');

  // Eight is the boundary and must still work, or the refusal is off by one.
  const eight = await byName['treasury-risk'].run({
    positions: Array.from({ length: 8 }, (_, i) => ({ asset: `S${i}`, amountUsd: 1000 * (i + 1) })),
    snark: true,
  });
  assert.equal(eight.snark.status, 'building', 'a book at the circuit\'s exact capacity was refused');

  // (b) A REFUSED REQUEST. No book, nothing to certify.
  const empty = await byName['treasury-risk'].run({ positions: [{ asset: 'USDC', amountUsd: 0 }], snark: true });
  assert.equal(empty.snark.status, 'unavailable');
  assert.match(empty.snark.reason, /no book to certify/);

  // (c) A WITNESS THAT MEASURES A DIFFERENT BOOK. The engine's answer for one book, handed a result
  //     whose published index has been moved by one displayed unit.
  const r = treasuryRisk(BOOK);
  const tampered = JSON.parse(JSON.stringify(r));
  tampered.concentration.byAsset.hhi = round(r.concentration.byAsset.hhi + 0.0001, 4);
  await buildConcentrationInBackground('gateH-wrong-answer', BOOK, tampered);
  const wrong = await getProof('gateH-wrong-answer');
  assert.equal(wrong.status, 'unavailable');
  assert.match(wrong.error, /refusing to certify a different book/);
  assert.match(wrong.error, /witness measures this book at/);

  console.log(`  H.6  nine assets -> named with the count; eight -> proved; wrong index -> ${wrong.error.slice(0, 64)}…`);
});

// ── H.7 both surfaces, and nothing that already worked moved ─────────────────────────────────────

const PINNED = '3d40bbc180e0d33f1d8bed2f60f968530c69bc9fd85da57c14bd0ffb0224ed08';
const FIXTURE = { positions: [{ asset: 'USDC', amountUsd: 1000000, apyPct: 4.5 }] };

test('H.7 both surfaces carry the proof, and no content hash moved to get it', async () => {
  const mcp = async (args) => {
    const r = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'treasury_risk', arguments: args } });
    return JSON.parse(r.result.content[0].text);
  };

  const http = await byName['treasury-risk'].run(FIXTURE);
  const free = await mcp(FIXTURE);
  assert.equal(http.proof.contentHash, PINNED, `HTTP treasury-risk#0 moved: ${http.proof.contentHash}`);
  assert.equal(free.proof.contentHash, PINNED, `MCP treasury-risk#0 moved: ${free.proof.contentHash}`);
  assert.equal('snark' in http, false, 'a caller who asked for nothing got a snark sibling');
  assert.equal('snark' in free, false, 'a caller who asked for nothing got a snark sibling');

  const httpS = await byName['treasury-risk'].run({ ...FIXTURE, snark: true });
  const freeS = await mcp({ ...FIXTURE, snark: true });
  assert.equal(httpS.proof.contentHash, PINNED, 'asking for a proof moved the HTTP hash');
  assert.equal(freeS.proof.contentHash, PINNED, 'asking for a proof moved the MCP hash');
  assert.ok(httpS.snark && freeS.snark, 'a surface attached no snark sibling');
  // A single-asset book has H = 1 exactly, which is the circuit's upper bound and must still prove.
  assert.equal(httpS.snark.indexProven, 1);
  assert.equal(httpS.snark.status, 'building', 'the single-asset boundary book was refused');

  assert.ok(freeS.proof.excludedFromContentHash.includes('snark'),
    `the MCP response attached \`snark\` and did not declare it: ${JSON.stringify(freeS.proof.excludedFromContentHash)}`);
  const followed = followPublishedRecipe(freeS);
  assert.equal(followed.ok, true,
    `the response carrying a snark sibling fails its own published recipe: recomputed ${followed.recomputed}, published ${followed.published}`);

  for (const k of ['protocol', 'circuit', 'status', 'retrieveAt', 'verificationKey', 'dimensionProven', 'indexProven', 'assetsProven', 'proves', 'doesNotProve']) {
    assert.deepEqual(httpS.snark[k], freeS.snark[k], `the two surfaces disagree about \`${k}\` on the same request`);
  }

  console.log(`  H.7  treasury-risk#0 ${PINNED.slice(0, 12)}… unmoved on both surfaces, with and without the flag; H = 1 boundary proves`);
});
