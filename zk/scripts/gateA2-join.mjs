// GATE A2 — THE JOIN. One call proves the input came from HyperCore's committed state AND that the
// arithmetic on it is correct.
//
// Done means, and every one of these is checked on chain 999 against the real precompile:
//   · an honest proof whose entry price is the live mark VERIFIES
//   · the same proof, once the mark has moved past the window, is REFUSED — and the refusal is
//     produced by waiting for the market to actually move, not by asserting that it would
//   · a proof for a DIFFERENT ASSET is refused
//   · a BENT proof is refused
//   · an asset the precompile cannot answer for is refused, rather than silently comparing against 0
//
// The window is not chosen here. It is read from gateA3-staleness.json, which measured it. Running
// this gate without that file is refused, because a window picked to make a gate pass is not a window.
//
// Run: node zk/scripts/gateA2-join.mjs [--window <ppm>] [--drift-wait 360]
import fs from 'node:fs';
import path from 'node:path';
import {
  BUILD, CONTRACTS, rpc, u32, perpUniverse, compile, readSol, runtimeCodeFor, abiWords, selector,
  callPlantedRaw, namedRevert, checklist, proveLiquidation, verifyOffChain, scaleLib, gridMul, shutdown, PRECOMPILES,
} from './lib/perpkit.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const DRIFT_WAIT = Number(arg('--drift-wait', 420));
const g = checklist();
console.log(`GATE A2 — the join, on chain 999 — ${new Date().toISOString()}\n`);

// ── the window comes from the measurement ─────────────────────────────────────────────────────────
let windowPpm = arg('--window', null);
let windowTicks = arg('--window-ticks', null);
let windowSource = 'command line';
if (windowPpm == null || windowTicks == null) {
  const f = path.join(BUILD, 'gateA3-staleness.json');
  if (!fs.existsSync(f)) {
    console.error('No measured window. Run gateA3-staleness.mjs first, or pass --window <ppm> --window-ticks <n> and say where they came from.');
    process.exit(2);
  }
  const a3 = JSON.parse(fs.readFileSync(f, 'utf8'));
  windowPpm = windowPpm ?? a3.recommendWindowPpm;
  windowTicks = windowTicks ?? a3.recommendWindowTicks ?? 1;
  windowSource = `gateA3-staleness.json (${a3.at}, ${a3.samples} samples over ${a3.seconds}s)`;
}
windowPpm = BigInt(windowPpm);
windowTicks = BigInt(windowTicks);
console.log(`  windowPpm ${windowPpm} · windowTicks ${windowTicks} — from ${windowSource}\n`);

// ── build and plant ───────────────────────────────────────────────────────────────────────────────
const V = compile('PlonkVerifier.sol', 'PlonkVerifier', { 'PlonkVerifier.sol': { content: readSol(path.join(BUILD, 'PlonkVerifier.sol')) } });
const Q = compile('QuiverPerpVerifier.sol', 'QuiverPerpVerifier', { 'QuiverPerpVerifier.sol': { content: readSol(path.join(CONTRACTS, 'QuiverPerpVerifier.sol')) } });

const VERIFIER_AT = '0x00000000000000000000000000000000000A02FF';
const JOIN_AT = '0x00000000000000000000000000000000000A0200';
const { code: joinRuntime } = await runtimeCodeFor(Q.evm.bytecode.object, abiWords(VERIFIER_AT, windowPpm, windowTicks));
const overrides = {
  [VERIFIER_AT]: { code: '0x' + V.evm.deployedBytecode.object },
  [JOIN_AT]: { code: joinRuntime },
};
console.log(`  planted: PlonkVerifier ${V.evm.deployedBytecode.object.length / 2} bytes at ${VERIFIER_AT}`);
console.log(`           QuiverPerpVerifier ${(joinRuntime.length - 2) / 2} bytes at ${JOIN_AT} (windowPpm baked into the runtime)\n`);

const SEL = {
  verifyPerpGate: await selector('verifyPerpGate(uint256[24],uint256[8],uint32)'),
  verifyProof: await selector('verifyProof(uint256[24],uint256[8])'),
  markPxHat: await selector('markPxHat(uint32)'),
  deviationPpm: await selector('deviationPpm(uint256[8],uint32)'),
  marksHat: await selector('marksHat(uint32[])'),
  windowPpm: await selector('windowPpm()'),
  windowTicks: await selector('windowTicks()'),
  allowed: await selector('allowedDeviationHat(uint32)'),
};
const ERRS = [
  'PrecompileUnavailable(address,uint32)', 'PrecompileShortReturn(address,uint32,uint256)',
  'ImplausibleSzDecimals(uint32,uint256)', 'MarkMismatch(uint32,uint256,uint256,uint256,uint256)',
  'ProofRejected()',
];

const pad = (v) => BigInt(v).toString(16).padStart(64, '0');
const gateCall = (pr, pu, asset) => SEL.verifyPerpGate + [...pr, ...pu].map(pad).join('') + u32(asset);

async function join(label, pr, pu, asset, expect) {
  const r = await callPlantedRaw({ to: JOIN_AT, data: gateCall(pr, pu, asset), overrides });
  const err = r.ok ? null : await namedRevert(r.data, ERRS);
  const value = r.ok ? BigInt(r.result) === 1n : false;
  const got = r.ok ? `returned ${value}` : `REVERTED ${err}`;
  const ok = expect === 'accept' ? value === true : (!r.ok && String(err).startsWith(expect));
  console.log(`  [${ok ? 'PASS' : '*** FAIL ***'}] ${label.padEnd(46)} ${got}`);
  return { ok, err, value, raw: r };
}

const chainWindow = await callPlantedRaw({ to: JOIN_AT, data: SEL.windowPpm, overrides });
const chainTicks = await callPlantedRaw({ to: JOIN_AT, data: SEL.windowTicks, overrides });
g.record('the planted contract carries the measured window in its own bytecode',
  BigInt(chainWindow.result) === windowPpm && BigInt(chainTicks.result) === windowTicks,
  `windowPpm() = ${BigInt(chainWindow.result)} · windowTicks() = ${BigInt(chainTicks.result)}`);

// ── the honest case ───────────────────────────────────────────────────────────────────────────────
// Read the mark, bind it as the entry price, prove, submit. This is exactly what perp-gate does in
// symbol mode when the caller supplies no entryPrice: `_entryDefaultedToMark`.
const universe = await perpUniverse();
const BTC = universe.find((u) => u.name === 'BTC').perpIndex;
const ETH = universe.find((u) => u.name === 'ETH').perpIndex;
const scale = scaleLib();
const S = 10n ** 9n;

const readHat = async (asset) => {
  const r = await callPlantedRaw({ to: JOIN_AT, data: SEL.markPxHat + u32(asset), overrides });
  if (!r.ok) throw new Error(`markPxHat(${asset}) reverted`);
  return BigInt(r.result);
};

const t0 = Date.now();
const markNow = await readHat(BTC);
// A 10x long of 1 BTC entered at the mark. Margin at full precision from the mark itself, exactly the
// way `witnessFor` recomputes it rather than reading the display-rounded echo.
const position = (p0) => ({ mHat: (1n * p0) / 10n, qHat: S, p0Hat: p0, s: 1, mmrHat: scale.toScaled(0.0125, 'mmr') });
const honest = await proveLiquidation(position(markNow));
const okOff = await verifyOffChain(honest.publicSignals, honest.proof);
console.log(`  BTC mark ${Number(markNow) / 1e9} bound as the entry price · proved in ${Date.now() - t0} ms · off-chain verify ${okOff}`);
g.record('the proof binds the precompile mark exactly, with no rounding in between',
  BigInt(honest.pubWords[4]) === markNow, `publicSignals[4] = ${BigInt(honest.pubWords[4])} · markPxHat = ${markNow}`);

console.log('\nThe join:');
const acc = await join('honest proof, live mark, right asset', honest.proofWords, honest.pubWords, BTC, 'accept');
g.record('an honest proof whose price matches the live mark VERIFIES', acc.ok,
  acc.ok ? 'one call: HyperCore committed the input, the SNARK committed the arithmetic' : `got ${acc.err}`);

// ── the refusals ──────────────────────────────────────────────────────────────────────────────────
// 1. a different asset
const wrongAsset = await join('same proof, asset = ETH instead of BTC', honest.proofWords, honest.pubWords, ETH, 'MarkMismatch');
g.record('a proof submitted against a different asset is refused', wrongAsset.ok, `${wrongAsset.err}`);

// 2. a bent proof, at the right price
const bent = [...honest.proofWords];
bent[0] = '0x' + (BigInt(bent[0]) + 1n).toString(16);
const bentRes = await join('bent proof point, price still right', bent, honest.pubWords, BTC, 'ProofRejected');
g.record('a bent proof is refused even when the price is right', bentRes.ok, `${bentRes.err}`);

// 3. an asset the precompile has no answer for
const noAsset = await join('asset 99999, which HyperCore has no answer for', honest.proofWords, honest.pubWords, 99999, 'PrecompileUnavailable');
g.record('an unanswerable asset is refused rather than compared against zero', noAsset.ok, `${noAsset.err}`);

// 4. one grid step outside the window — the scripted revert, always available, never market-dependent.
// The bound comes from the CONTRACT's own `allowedDeviationHat`, not from arithmetic repeated here: a
// gate that recomputes the boundary it is testing is checking its own copy of the rule.
const allowed = await callPlantedRaw({ to: JOIN_AT, data: SEL.allowed + u32(BTC), overrides });
const allowedHat = BigInt('0x' + allowed.result.replace(/^0x/, '').slice(64, 128));
const chainHatNow = BigInt('0x' + allowed.result.replace(/^0x/, '').slice(0, 64));
console.log(`\n  the contract's own bound for BTC: ${allowedHat} on the 1e9 grid `
  + `(${(Number(allowedHat) / Number(chainHatNow) * 1e6).toFixed(1)} ppm of a ${Number(chainHatNow) / 1e9} mark)`);

const outside = chainHatNow + allowedHat + 1n;
const scripted = await proveLiquidation(position(outside));
const scriptedRes = await join(`price allowed+1 on the grid, proof otherwise perfect`, scripted.proofWords, scripted.pubWords, BTC, 'MarkMismatch');
g.record('a price one grid step outside the contract\'s own bound is refused, by construction',
  scriptedRes.ok, `${scriptedRes.err}`);

// 4b. and one INSIDE the window is still accepted, so the window is a window and not a wall
const insideP = chainHatNow + allowedHat / 2n;
const inside = await proveLiquidation(position(insideP));
const insideRes = await join(`price allowed/2 off, inside the window`, inside.proofWords, inside.pubWords, BTC, 'accept');
g.record('a price inside the window is still accepted, so the gate is a window and not a wall',
  insideRes.ok, `${((Number(insideP - chainHatNow) / Number(chainHatNow)) * 1e6).toFixed(1)} ppm away`);

// 4c. the tick floor is not decoration: on a coarse-grid asset it must be the binding constraint.
// Sized on the majors, a ppm-only window is smaller than one tick there, and the gate would be
// unsatisfiable rather than strict.
const liveAssets = universe.filter((u) => !u.isDelisted);
const coarse = [];
const unread = [];
for (let i = 0; i < liveAssets.length; i += 20) {
  // Chunked, and failures are COUNTED rather than dropped: a silent `.filter(Boolean)` over a
  // rate-limited fan-out turns "9 requests were throttled" into "9 assets do not have this property".
  const part = await Promise.all(liveAssets.slice(i, i + 20).map(async (u) => {
    try {
      const r = await callPlantedRaw({ to: JOIN_AT, data: SEL.allowed + u32(u.perpIndex), overrides, tries: 4 });
      if (!r.ok) return { fail: u.name };
      const h = BigInt('0x' + r.result.replace(/^0x/, '').slice(0, 64));
      const a = BigInt('0x' + r.result.replace(/^0x/, '').slice(64, 128));
      return { name: u.name, idx: u.perpIndex, hat: h, allowed: a, ppm: (Number(a) / Number(h)) * 1e6 };
    } catch { return { fail: u.name }; }
  }));
  for (const p of part) (p.fail ? unread : coarse).push(p);
}
if (unread.length) console.log(`  (${unread.length} of ${liveAssets.length} assets could not be read on this pass: ${unread.slice(0, 6).map((u) => u.fail).join(', ')})`);
const tickBound = coarse.filter((c) => c.ppm > Number(windowPpm) + 0.5);
g.record('the tick-floor survey read enough of the universe to mean anything',
  unread.length <= liveAssets.length / 10,
  `${coarse.length} read, ${unread.length} unread of ${liveAssets.length} live perps`);
if (unread.length > liveAssets.length / 4) g.record('the tick-floor survey read enough of the universe to mean anything', false, );
console.log(`  the tick floor binds on ${tickBound.length} of ${coarse.length} assets — e.g. `
  + tickBound.sort((a, b) => b.ppm - a.ppm).slice(0, 3).map((c) => `${c.name} ${c.ppm.toFixed(0)} ppm`).join(', '));
g.record('the tick floor is the binding constraint somewhere, so it is not decoration',
  tickBound.length > 0,
  `${tickBound.length}/${coarse.length} assets need more than the ${windowPpm}-ppm window just to represent one tick`);

// ── 5. THE ONE THAT CAN FAIL: a real proof going stale in real time ───────────────────────────────
// The build plan calls this "the one worth writing the gate around". It is built by holding an honest
// proof and waiting for the market, not by moving a number.
console.log(`\nStaleness in real time — holding the honest proof and waiting for the mark to move past the contract's own bound (up to ${DRIFT_WAIT}s):`);
const held = { asset: BTC, hat: markNow, proofWords: honest.proofWords, pubWords: honest.pubWords, at: Date.now() };
let breach = null;
const tStart = Date.now();
while ((Date.now() - tStart) / 1000 < DRIFT_WAIT) {
  await new Promise((s) => setTimeout(s, 5000));
  const a = await callPlantedRaw({ to: JOIN_AT, data: SEL.allowed + u32(held.asset), overrides });
  const now = BigInt('0x' + a.result.replace(/^0x/, '').slice(0, 64));
  const bound = BigInt('0x' + a.result.replace(/^0x/, '').slice(64, 128));
  const d = now > held.hat ? now - held.hat : held.hat - now;
  const ppm = (d * 1_000_000n) / now;
  process.stdout.write(`\r    ${((Date.now() - tStart) / 1000).toFixed(0)}s elapsed · mark ${Number(now) / 1e9} · ${d} of ${bound} allowed on the grid (${ppm} ppm)      `);
  if (d > bound) { breach = { ppm, now, elapsedSec: (Date.now() - held.at) / 1000 }; break; }
}
console.log('');
if (breach) {
  const stale = await join(`the SAME proof, ${breach.elapsedSec.toFixed(0)}s later, mark ${breach.ppm} ppm away`, held.proofWords, held.pubWords, held.asset, 'MarkMismatch');
  g.record('a proof whose mark has genuinely moved past the window is REFUSED', stale.ok,
    `refused after ${breach.elapsedSec.toFixed(0)}s of real market movement, ${breach.ppm} ppm · ${stale.err}`);
  // and it is refused for the RIGHT reason: the arithmetic is still perfectly good
  const stillGood = await callPlantedRaw({ to: JOIN_AT, data: SEL.verifyProof + [...held.proofWords, ...held.pubWords].map(pad).join(''), overrides });
  g.record('the stale proof is refused for its INPUT, not its arithmetic — verifyProof still returns true',
    stillGood.ok && BigInt(stillGood.result) === 1n,
    `verifyProof on the same proof: ${stillGood.ok ? BigInt(stillGood.result) === 1n : 'reverted'}`);
} else {
  const now = await readHat(held.asset);
  const d = now > held.hat ? now - held.hat : held.hat - now;
  g.record('a proof whose mark has genuinely moved past the window is REFUSED', false,
    `the mark did not move past the contract's own bound within ${DRIFT_WAIT}s (reached ${(d * 1_000_000n) / now} ppm). `
    + 'That is a property of the market on the day, not a pass: rerun in a livelier hour or lengthen --drift-wait. '
    + 'The scripted out-of-window refusal above still holds.');
}

// ── deviation, and gas ────────────────────────────────────────────────────────────────────────────
const dev = await callPlantedRaw({ to: JOIN_AT, data: SEL.deviationPpm + honest.pubWords.map(pad).join('') + u32(BTC), overrides });
// Gas for the join, measured against a proof that will still be ACCEPTED at this instant — estimating
// a call that reverts returns the revert, not a cost. So it is re-proved at the mark as it stands now.
const nowHat = await readHat(BTC);
const fresh = await proveLiquidation(position(nowHat));
const gas = await rpc('eth_estimateGas', [{ from: '0x000000000000000000000000000000000000dEaD', to: JOIN_AT, data: gateCall(fresh.proofWords, fresh.pubWords, BTC), gas: '0x1D4C00' }, 'latest', overrides])
  .catch((e) => { console.log(`  (gas estimate unavailable: ${String(e.message).slice(0, 120)})`); return null; });
const gasVerifyOnly = await rpc('eth_estimateGas', [{ from: '0x000000000000000000000000000000000000dEaD', to: JOIN_AT, data: SEL.verifyProof + [...fresh.proofWords, ...fresh.pubWords].map(pad).join(''), gas: '0x1D4C00' }, 'latest', overrides]).catch(() => null);
const gp = BigInt(await rpc('eth_gasPrice', []));
console.log(`\n  deviationPpm right now: ${dev.ok ? BigInt(dev.result) : 'reverted'} ppm`);
if (gas) {
  console.log(`  verifyPerpGate:  ${BigInt(gas)} gas × ${Number(gp) / 1e9} gwei = ${Number(BigInt(gas) * gp) / 1e18} HYPE per call`);
  if (gasVerifyOnly) console.log(`  verifyProof only: ${BigInt(gasVerifyOnly)} gas — the join costs ${BigInt(gas) - BigInt(gasVerifyOnly)} more, which is what two precompile reads and the comparison are worth`);
}

const failed = g.failed();
console.log(`\n${'='.repeat(78)}`);
console.log(`GATE A2: ${failed.length === 0 ? 'PASSED' : `FAILED — ${failed.map((f) => f.name).join('; ')}`}`);

fs.writeFileSync(path.join(BUILD, 'gateA2-join.json'), JSON.stringify({
  at: new Date().toISOString(), passed: failed.length === 0, windowPpm: String(windowPpm), windowSource,
  btcMarkHat: String(markNow), publicSignals: honest.publicSignals,
  joinGas: gas ? String(BigInt(gas)) : null, verifyOnlyGas: gasVerifyOnly ? String(BigInt(gasVerifyOnly)) : null, gasPriceWei: String(gp),
  tickFloorBinds: { assets: tickBound.length, of: coarse.length, worst: tickBound.slice(0, 5).map((c) => ({ name: c.name, ppm: Math.round(c.ppm) })) },
  realDriftBreach: breach ? { ppm: String(breach.ppm), elapsedSec: breach.elapsedSec } : null,
  checks: g.results,
}, null, 2) + '\n', 'utf8');
await shutdown();
process.exit(failed.length === 0 ? 0 : 1);
